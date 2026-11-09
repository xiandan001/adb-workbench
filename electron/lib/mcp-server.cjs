const { tr } = require('./localization.cjs');
// MCP HTTP Server 集成 - 提供 AI 工具接口
// 该模块启动一个 HTTP 服务器，实现 MCP（Model Context Protocol）协议
// 通过 log-analyzer / ai-analyze 的 getter/setter 操作共享日志与 AI 状态

const http = require('http');
const { randomUUID } = require('crypto');
const https = require('./ai-outbound-transport.cjs');

const ctx = require('./app-context.cjs');
const logAnalyzer = require('./log-analyzer.cjs');
const aiAnalyze = require('./ai-analyze.cjs');
const packageManager = require('./package-manager.cjs');
const performanceMonitor = require('./performance-monitor.cjs');
const inspection = require('./inspection.cjs');
const vip = require('./vip.cjs');
const { getAppVersion } = require('./version.cjs');
const {
  AGNES_API_URL,
  AGNES_API_KEY,
  AGNES_MODEL,
  AI_MAX_LOG_LINES,
  AI_MAPREDUCE_THRESHOLD_BYTES,
  AI_CHUNK_LINES,
} = aiAnalyze.aiKeys;

const MCP_SERVER_NAME = 'Device Log Analyzer MCP';
const MCP_SERVER_VERSION = getAppVersion();
const MCP_PROTOCOL_VERSION = '2025-03-26';
let mcpPort = 49321;
let mcpServerInstance = null;
const mcpSessions = new Map();
const mcpAiRequests = new Map();
// MCP 会话清理定时器需要随服务生命周期启停，避免反复启动/停止后累积 interval。
let mcpSessionCleanupTimer = null;

function buildMcpTools() {
  return [
    {
      name: 'device_list',
      description: tr('列出 ADB/HDC 发现的设备、平台和连接状态；仅 status=device 可执行设备操作，Ready 不代表已连接。'),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'capture_start',
      description: tr('开始采集所选设备日志。Android 使用 Logcat，鸿蒙使用 HiLog；多设备时必须明确指定目标。'),
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: tr('设备 ID（从 device_list 获取）；仅有一台已连接设备时可以省略。') },
          types: { type: 'array', description: tr('鸿蒙 HiLog 类型；内核日志须单独选择。'), items: { type: 'string', enum: ['app', 'core', 'init', 'kmsg'] } },
          buffers: {
            type: 'array',
            description: tr("要抓取的日志缓冲区列表。默认不传（adb 默认 main/system/crash）。可选值：main, system, radio, events, crash, kernel"),
            items: { type: 'string', enum: ['main', 'system', 'radio', 'events', 'crash', 'kernel'] }
          }
        },
        additionalProperties: false
      }
    },
    {
      name: 'capture_stop',
      description: tr('停止当前设备日志采集，不影响其他采集进程。'),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'log_clear',
      description: tr('清空所选日志来源；实时来源仅清理其绑定设备的日志缓冲，文件来源不操作设备。'),
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['realtime', 'file'], description: tr("要清空的日志源，默认 realtime") },
          deviceId: { type: 'string', description: tr('可选的实时来源设备 ID；与当前采集目标不一致时拒绝清理。') }
        },
        additionalProperties: false
      }
    },
    {
      name: 'log_sources',
      description: tr("列出可读取的日志源（realtime/file）及其当前条数"),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'package_list',
      description: tr("列出指定设备已安装应用。默认只返回用户应用；showSystem=true 时包含系统应用。"),
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: tr("设备 ID（从 device_list 获取）") },
          showSystem: { type: 'boolean', description: tr("是否包含系统应用，默认 false") },
          limit: { type: 'integer', minimum: 1, maximum: 1000, description: tr("最大返回数量，默认 200") }
        },
        required: ['deviceId'],
        additionalProperties: false
      }
    },
    {
      name: 'package_detail',
      description: tr("读取指定应用的版本、路径、安装时间、启停状态和权限摘要。"),
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: tr("设备 ID（从 device_list 获取）") },
          packageName: { type: 'string', description: tr('Android 包名或鸿蒙 Bundle 名，例如 com.example.app') }
        },
        required: ['deviceId', 'packageName'],
        additionalProperties: false
      }
    },
    {
      name: 'perf_snapshot',
      description: tr('读取所选平台支持的性能指标；缺失指标返回不可用原因，不代表零占用或健康。'),
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: tr("设备 ID（从 device_list 获取）") },
          includeProcesses: { type: 'boolean', description: tr("是否包含进程占用；非会员会自动降级为 false") }
        },
        required: ['deviceId'],
        additionalProperties: false
      }
    },
    {
      name: 'inspection_run',
      description: tr("对指定设备执行一次标准巡检并导出报告与证据包。bugreport 默认不包含，避免耗时过长。"),
      inputSchema: {
        type: 'object',
        properties: {
          deviceId: { type: 'string', description: tr("设备 ID（从 device_list 获取）") },
          includeBugreport: { type: 'boolean', description: tr("是否包含 bugreport，默认 false") },
          includeAiSummary: { type: 'boolean', description: tr("是否包含 AI 总结，默认 true") },
          outputBaseDir: { type: 'string', description: tr("可选输出目录；不填使用应用默认目录") }
        },
        required: ['deviceId'],
        additionalProperties: false
      }
    },
    {
      name: 'log_get',
      description: tr("读取指定日志源的原始日志（支持分页）"),
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['realtime', 'file'], description: tr("日志源") },
          offset: { type: 'integer', minimum: 0, description: tr("起始偏移量，默认 0") },
          limit: { type: 'integer', minimum: 1, maximum: 5000, description: tr("返回条数，默认 200") }
        },
        required: ['source'],
        additionalProperties: false
      }
    },
    {
      name: 'log_filter',
      description: tr("对指定日志源进行过滤并返回匹配结果（支持分页）"),
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['realtime', 'file'], description: tr("日志源") },
          filter: {
            type: 'object',
            description: tr("过滤条件"),
            properties: {
              minLevel: { type: 'string', enum: ['V', 'D', 'I', 'W', 'E', 'F'], description: tr("最低日志级别") },
              tag: { type: 'string', description: tr("Tag 关键词（包含）") },
              pid: { type: 'string', description: tr("进程 PID") },
              pkg: { type: 'string', description: tr('包名或 HiLog 进程名关键词') },
              domain: { type: 'string', description: tr('HiLog Domain 关键词') },
              text: { type: 'string', description: tr("消息关键词（包含）") },
              excludeText: { type: 'string', description: tr("排除消息关键词") },
              regex: { type: 'string', description: tr("正则表达式匹配消息") }
            }
          },
          offset: { type: 'integer', minimum: 0, description: tr("起始偏移量，默认 0") },
          limit: { type: 'integer', minimum: 1, maximum: 5000, description: tr("返回条数，默认 200") }
        },
        required: ['source', 'filter'],
        additionalProperties: false
      }
    },
    {
      name: 'log_stats',
      description: tr("统计指定日志源在过滤条件下的各级别数量"),
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['realtime', 'file'], description: tr("日志源") },
          filter: { type: 'object', description: tr("过滤条件（可选）") }
        },
        required: ['source'],
        additionalProperties: false
      }
    },
    {
      name: 'log_watch',
      description: tr("等待指定关键词出现在新日志中（轮询方式）。适用于：AI 修改代码并部署后，等待特定 Log 输出出现来验证代码是否生效。超时后返回空结果。"),
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['realtime', 'file'], description: tr("日志源，默认 realtime") },
          keyword: { type: 'string', description: tr("要等待的关键词") },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 120000, description: tr("超时时间（毫秒），默认 30000") },
          intervalMs: { type: 'integer', minimum: 500, maximum: 5000, description: tr("轮询间隔（毫秒），默认 1000") }
        },
        required: ['keyword'],
        additionalProperties: false
      }
    },
    {
      name: 'ai_analyze',
      description: tr("启动 AI 日志分析（非流式，等待完整结果后返回）。基于当前抓取的日志进行分析。可选传入自定义分析要求。"),
      inputSchema: {
        type: 'object',
        properties: {
          source: { type: 'string', enum: ['realtime', 'file'], description: tr("日志源，默认 realtime") },
          filter: {
            type: 'object',
            description: tr("过滤条件（可选）"),
            properties: {
              minLevel: { type: 'string', enum: ['V', 'D', 'I', 'W', 'E', 'F'], description: tr("最低日志级别") },
              tag: { type: 'string', description: tr("Tag 关键词") },
              pid: { type: 'string', description: 'PID' },
              pkg: { type: 'string', description: tr('包名或 HiLog 进程名关键词') },
              domain: { type: 'string', description: tr('HiLog Domain 关键词') },
              text: { type: 'string', description: tr("消息关键词") },
              excludeText: { type: 'string', description: tr("排除消息关键词") },
              regex: { type: 'string', description: tr("正则表达式") }
            }
          },
          customPrompt: { type: 'string', description: tr("附加分析要求（可选），如\"重点关注内存泄漏\"") },
          timeoutMs: { type: 'integer', minimum: 5000, maximum: 300000, description: tr("超时时间（毫秒），默认 120000") }
        },
        additionalProperties: false
      }
    },
    {
      name: 'ai_get_result',
      description: tr("获取最近一次 AI 分析的结果（Markdown 格式）。如果没有分析过则返回空。"),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    {
      name: 'ai_clear',
      description: tr("清空 AI 分析结果和对话上下文，使下一次分析从头开始。"),
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    }
  ];
}

function mcpText(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
}

function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) throw new Error(tr('请求内容过大'));
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf-8');
  return raw ? JSON.parse(raw) : {};
}

async function callMcpTool(name, args, signal) {
  const { filterEntries, countByLevel } = require('../../src/shared/filter');

  // 通过 getter 访问 log-analyzer 的内部状态（保持模块边界清晰）
  const logStore = logAnalyzer.getLogStore();
  const currentLogSource = logAnalyzer.getCurrentLogSource();
  let logcatProc = logAnalyzer.getLogcatProc();

  if (name === 'device_list') {
    const devices = await require('./device-discovery.cjs').listDevices();
    return mcpText({ devices, count: devices.length });
  }

  if (name === 'capture_start') {
    if (logcatProc) return mcpText({ ok: false, message: tr("当前已在抓取中，请先停止当前抓取") });
    let deviceId = normalizeMcpDeviceId(args.deviceId);
    if (args.deviceId && !deviceId) return mcpText({ ok: false, error: tr('请选择有效的目标设备。') });
    if (!deviceId) {
      const devices = (await require('./device-discovery.cjs').listDevices()).filter(device => device.status === 'device');
      if (devices.length !== 1) return mcpText({ ok: false, error: tr('请明确选择一台已连接设备。') });
      deviceId = devices[0].id;
    }
    const result = await logAnalyzer.startLogCapture({ deviceId, buffers: args.buffers, types: args.types });
    return mcpText({ ...result, ...(result.ok ? { message: tr("已开始在设备 {0} 上抓取日志", { 0: deviceId }) } : {}) });
  }

  if (name === 'package_list') {
    const deviceId = normalizeMcpDeviceId(args.deviceId);
    if (!deviceId) return mcpText({ ok: false, error: 'device_required' });
    const limit = Math.max(1, Math.min(Number(args.limit ?? 200) || 200, 1000));
    const packages = await packageManager.listPackages(deviceId);
    const filtered = args.showSystem === true ? packages : packages.filter(item => item.system !== true);
    return mcpText({ ok: true, deviceId, count: filtered.length, packages: filtered.slice(0, limit) });
  }

  if (name === 'package_detail') {
    const deviceId = normalizeMcpDeviceId(args.deviceId);
    const packageName = normalizeMcpPackageName(args.packageName);
    if (!deviceId || !packageName) return mcpText({ ok: false, error: 'device_or_package_required' });
    const detail = await packageManager.getPackageDetail(deviceId, packageName);
    return mcpText({ ok: true, deviceId, detail });
  }

  if (name === 'perf_snapshot') {
    const deviceId = normalizeMcpDeviceId(args.deviceId);
    if (!deviceId) return mcpText({ ok: false, error: 'device_required' });
    const status = await vip.getStatusAsync();
    const includeProcesses = status.activated === true && args.includeProcesses !== false;
    const snapshot = await performanceMonitor.collectSnapshot(deviceId, includeProcesses);
    return mcpText({ ok: !snapshot.sampleError, deviceId, snapshot });
  }

  if (name === 'inspection_run') {
    const deviceId = normalizeMcpDeviceId(args.deviceId);
    if (!deviceId) return mcpText({ ok: false, error: 'device_required' });
    const status = await vip.getStatusAsync();
    if (!status.activated) {
      return mcpText({ ok: false, code: 'vip_required', error: tr("设备巡检为会员专属功能，请先开通会员") });
    }
    const task = { id: `mcp-inspection-${Date.now()}`, deviceId, sender: null, cancelled: false, currentProc: null };
    const result = await inspection.runInspection(task, {
      deviceId,
      deviceLabel: deviceId,
      includeBugreport: args.includeBugreport === true,
      includeAiSummary: args.includeAiSummary !== false,
      outputBaseDir: args.outputBaseDir
    });
    return mcpText({ ok: result.ok, deviceId, result });
  }

  if (name === 'capture_stop') {
    return mcpText({ ...await logAnalyzer.stopLogCapture(), message: tr("已停止抓取") });
  }

  if (name === 'log_clear') {
    const source = args.source ?? 'realtime';
    const result = await logAnalyzer.clearLogs({ source, deviceId: args.deviceId });
    return mcpText({ ...result, ...(result.ok ? { message: tr("{0} 日志已清空", { 0: source }) } : {}) });
  }

  if (name === 'log_sources') {
    return mcpText({
      sources: [
        { source: 'realtime', count: (logStore.realtime || []).length },
        { source: 'file', count: (logStore.file || []).length }
      ],
      capturing: !!logAnalyzer.getLogcatProc()
    });
  }

  if (name === 'log_get') {
    const source = args.source;
    const offset = Number(args.offset ?? 0);
    const limit = Number(args.limit ?? 200);
    const entries = logStore[source] || [];
    const page = entries.slice(offset, offset + limit).map(e => e.raw);
    return mcpText({ source, offset, limit, total: entries.length, lines: page });
  }

  if (name === 'log_filter') {
    const source = args.source;
    const offset = Number(args.offset ?? 0);
    const limit = Number(args.limit ?? 200);
    const entries = filterEntries(logStore[source] || [], args.filter ?? {});
    const page = entries.slice(offset, offset + limit).map(e => e.raw);
    return mcpText({ source, offset, limit, total: entries.length, filter: args.filter, lines: page });
  }

  if (name === 'log_stats') {
    const source = args.source;
    const entries = filterEntries(logStore[source] || [], args.filter ?? {});
    return mcpText({ source, filter: args.filter ?? {}, total: entries.length, levels: countByLevel(entries) });
  }

  if (name === 'log_watch') {
    const source = args.source ?? 'realtime';
    const keyword = String(args.keyword);
    const timeoutMs = Number(args.timeoutMs ?? 30000);
    const intervalMs = Number(args.intervalMs ?? 1000);
    const startCount = (logStore[source] || []).length;
    const deadline = Date.now() + Math.min(timeoutMs, 120000);
    return new Promise((resolve) => {
      const poll = () => {
        const entries = logStore[source] || [];
        const newEntries = entries.slice(startCount);
        const matched = newEntries.filter(e => e.raw.includes(keyword));
        if (matched.length > 0) {
          resolve(mcpText({ found: true, keyword, matchedCount: matched.length, lines: matched.slice(0, 50).map(e => e.raw) }));
          return;
        }
        if (Date.now() >= deadline) {
          resolve(mcpText({ found: false, keyword, message: tr("等待超时（{0}ms），未发现包含 \"{1}\" 的日志", { 0: timeoutMs, 1: keyword }), newEntriesSinceWatch: newEntries.length }));
          return;
        }
        setTimeout(poll, Math.min(intervalMs, 5000));
      };
      poll();
    });
  }

  if (name === 'ai_analyze') {
    return https.withOperation({ title: tr('MCP 请求 AI 日志分析'), kind: 'mcp', signal }, async () => {
    const source = args.source ?? 'realtime';
    const filter = args.filter ?? {};
    const customPrompt = args.customPrompt;
    const timeoutMs = Number(args.timeoutMs ?? 120000);

    const allEntries = filterEntries(logStore[source] || [], filter);
    if (allEntries.length === 0) {
      return mcpText({ ok: false, message: tr("没有可分析的日志，请先抓取或加载日志") });
    }

    // 格式化日志行
    const lines = allEntries.map(e => {
      if (e.logFormat === 'hilog' && e.raw) return e.raw;
      const d = new Date(e.ts);
      const ts = `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`;
      return `${ts} ${e.pid ?? 0} ${e.tid ?? e.pid ?? 0} ${e.level ?? 'V'} ${e.tag ?? ''}: ${e.message ?? e.raw}${e.pkg ? ` [pkg:${e.pkg}]` : ''}`;
    });

    const truncated = lines.length > AI_MAX_LOG_LINES;
    const effectiveLines = truncated ? lines.slice(lines.length - AI_MAX_LOG_LINES) : lines;

    // 判断是否需要 Map-Reduce
    const logBytes = Buffer.byteLength(effectiveLines.join('\n'), 'utf8');
    const needMapReduce = logBytes > AI_MAPREDUCE_THRESHOLD_BYTES && effectiveLines.length > AI_CHUNK_LINES;

    let systemPrompt, userContent;

    if (needMapReduce) {
      // Map-Reduce 路径：分块分析后合并（sender=null，MCP 无前端进度）
      const mrResult = await aiAnalyze.mapReduceAnalyze(effectiveLines, filter, customPrompt, null);
      systemPrompt = mrResult.systemPrompt;
      userContent = mrResult.userContent;
    } else {
      // 常规路径：直接发送完整日志
      const logContent = effectiveLines.join('\n');
      systemPrompt = aiAnalyze.buildAiSystemPrompt(filter);
      userContent = customPrompt
        ? tr("{0}\n\n--- 日志内容 ---\n{1}", { 0: customPrompt, 1: logContent })
        : tr('请分析以下设备日志：\n\n--- 日志内容 ---\n{0}', { 0: logContent });
    }

    // 构建消息（MCP 调用不使用多轮上下文，独立分析）
    const messages = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent }
    ];

    const requestBody = JSON.stringify({
      model: AGNES_MODEL,
      messages,
      stream: false,
      temperature: 0.3
    });

    const urlObj = new URL(AGNES_API_URL);

    // 非流式请求
    const result = await new Promise((resolve) => {
      let timer;

      const postReq = https.request({
        hostname: urlObj.hostname,
        port: 443,
        path: urlObj.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${AGNES_API_KEY}`
        }
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          clearTimeout(timer);
          if (res.statusCode !== 200) {
            resolve({ ok: false, error: tr("API返回 {0}: {1}", { 0: res.statusCode, 1: body.slice(0, 500) }) });
            return;
          }
          try {
            const json = JSON.parse(body);
            const content = json.choices?.[0]?.message?.content ?? '';
            aiAnalyze.setAiLastResult(content);
            resolve({ ok: true, result: content, totalLines: lines.length, truncated });
          } catch (e) {
            resolve({ ok: false, error: tr("解析响应失败: {0}", { 0: e.message }) });
          }
        });
      });

      postReq.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, code: e.code, cancelled: e.name === 'AbortError', error: e.message });
      });

      postReq.once('ai:authorized', () => {
        timer = setTimeout(() => {
          resolve({ ok: false, error: tr("AI 分析超时（{0}ms）", { 0: timeoutMs }) });
          postReq.destroy(Object.assign(new Error(tr("AI 分析超时（{0}ms）", { 0: timeoutMs })), { code: 'AI_SEND_TIMEOUT' }));
        }, timeoutMs);
      });

      postReq.write(requestBody);
      postReq.end();
    });

    return mcpText(result);
    });
  }

  if (name === 'ai_get_result') {
    const aiLastResult = aiAnalyze.getAiLastResult();
    return mcpText({ hasResult: !!aiLastResult, result: aiLastResult || '' });
  }

  if (name === 'ai_clear') {
    aiAnalyze.clearAiConversation();
    return mcpText({ ok: true, message: tr("AI 分析结果和对话上下文已清空") });
  }

      throw new Error(tr('未知工具：{0}', { 0: name }));
}

function startMcpHttpServer() {
  const tools = buildMcpTools();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');

    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }

    if (req.method === 'GET' && url.pathname === '/health') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, server: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/mcp/config') {
      const host = req.headers.host ?? `127.0.0.1:${mcpPort}`;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { url: `http://${host}/mcp`, headers: {} } } }));
      return;
    }

    if (url.pathname === '/mcp') {
      if (req.method === 'POST') {
        let body;
        try { body = await readJsonBody(req, 2 * 1024 * 1024); } catch {
          res.statusCode = 400;
          res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(jsonRpcError(null, -32700, 'Parse error')));
          return;
        }
        const id = body.id ?? null;

        if (body.method === 'initialize') {
          const sessionId = randomUUID();
          mcpSessions.set(sessionId, { createdAt: Date.now() });
          res.statusCode = 200;
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Mcp-Session-Id', sessionId);
          res.end(JSON.stringify(jsonRpcResult(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION }
          })));
          return;
        }

        if (body.method === 'notifications/cancelled') {
          const sessionId = req.headers['mcp-session-id'];
          if (mcpSessions.has(sessionId)) mcpAiRequests.get(`${sessionId}:${JSON.stringify(body.params?.requestId)}`)?.abort();
          res.statusCode = 202; res.end(); return;
        }
        if (body.method?.startsWith('notifications/')) { res.statusCode = 202; res.end(); return; }
        if (body.method === 'ping') {
          res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(jsonRpcResult(id, {}))); return;
        }
        if (body.method === 'tools/list') {
          res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
          res.end(JSON.stringify(jsonRpcResult(id, { tools }))); return;
        }
        if (body.method === 'tools/call') {
          const toolName = body.params?.name;
          const toolArgs = body.params?.arguments ?? {};
          if (!toolName) {
            res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(jsonRpcError(id, -32602, 'Missing tool name'))); return;
          }
          const controller = toolName === 'ai_analyze' ? new AbortController() : null;
          const sessionId = req.headers['mcp-session-id'];
          const requestKey = controller && mcpSessions.has(sessionId) ? `${sessionId}:${JSON.stringify(id)}` : null;
          const disconnected = () => { if (!res.writableEnded) controller?.abort(); };
          if (controller) res.once('close', disconnected);
          if (requestKey) {
            if (mcpAiRequests.has(requestKey)) { res.statusCode = 409; res.end(); return; }
            mcpAiRequests.set(requestKey, controller);
          }
          try {
            const result = await callMcpTool(toolName, toolArgs, controller?.signal);
            if (res.destroyed) return;
            res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(jsonRpcResult(id, result)));
          } catch (e) {
            if (res.destroyed) return;
            res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify(jsonRpcError(id, -32000, e?.message ?? 'Tool execution failed')));
          } finally {
            if (requestKey && mcpAiRequests.get(requestKey) === controller) mcpAiRequests.delete(requestKey);
            if (controller) res.off('close', disconnected);
          }
          return;
        }
        res.statusCode = 200; res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(jsonRpcError(id, -32601, 'Method not found')));
        return;
      }
      if (req.method === 'GET') {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.statusCode = 200;
        res.write(': ping\n\n');
        // 客户端关闭连接时显式结束响应，清理 SSE 连接资源，防止句柄泄漏
        req.on('close', () => {
          try { res.end(); } catch {}
        });
        return;
      }
      if (req.method === 'DELETE') {
        const sid = req.headers['mcp-session-id'];
        if (sid) for (const [key, controller] of mcpAiRequests) if (key.startsWith(`${sid}:`)) { controller.abort(); mcpAiRequests.delete(key); }
        if (sid) mcpSessions.delete(sid);
        res.statusCode = 204; res.end(); return;
      }
    }

    res.statusCode = 404; res.end();
  });

  return server;
}

function initMcpServer() {
  const server = startMcpHttpServer();
  server.on('error', (error) => {
    if (error?.code === 'EADDRINUSE') {
      console.warn(`[MCP] Server port ${mcpPort} is already in use, skip starting local MCP server.`);
      return;
    }
    console.error('[MCP] Server failed:', error);
  });
  server.listen(mcpPort, '127.0.0.1', () => {
    console.log(`[MCP] Server listening on http://127.0.0.1:${mcpPort}`);
    mcpServerInstance = server;
  });
  if (!mcpSessionCleanupTimer) {
    mcpSessionCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, s] of mcpSessions) {
        if (now - s.createdAt > 3600000) mcpSessions.delete(id);
      }
    }, 300000);
    mcpSessionCleanupTimer.unref?.();
  }
}

function register(ipcMain) {
  ipcMain.handle('mcp:getInfo', async () => {
    return { port: mcpPort, url: `http://127.0.0.1:${mcpPort}/mcp`, running: !!mcpServerInstance };
  });

  ipcMain.handle('mcp:start', async () => {
    try {
      const status = vip.getStatus();
      if (!status.activated) {
        return { ok: false, running: false, error: tr("VIP 会员专属功能，请先开通会员"), code: 'vip_required' };
      }
      if (!mcpServerInstance) initMcpServer();
      return { ok: true, running: true };
    } catch (e) {
      return { ok: false, running: false, error: e.message };
    }
  });

  ipcMain.handle('mcp:stop', async () => {
    closeMcpServer();
    return { ok: true, running: false };
  });
}

// 供 main 进程退出时调用，关闭 MCP HTTP server
function closeMcpServer() {
  for (const controller of mcpAiRequests.values()) controller.abort();
  mcpAiRequests.clear();
  if (mcpServerInstance) {
    try {
      mcpServerInstance.close();
    } catch (e) { /* ignore */ }
    mcpServerInstance = null;
  }
  if (mcpSessionCleanupTimer) {
    clearInterval(mcpSessionCleanupTimer);
    mcpSessionCleanupTimer = null;
  }
  mcpSessions.clear();
}

function normalizeMcpDeviceId(value) {
  return String(value || '').trim();
}

function normalizeMcpPackageName(value) {
  const name = String(value || '').trim();
  return /^[A-Za-z0-9_.]+$/.test(name) ? name : '';
}

module.exports = {
  register,
  initMcpServer,
  closeMcpServer,
};
