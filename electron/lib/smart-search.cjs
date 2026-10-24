const { tr } = require('./localization.cjs');
// 智能日志搜索：AI 分块搜索引擎
// 用户输入自然语言查询 → 日志分块 → AI 逐块搜索 → 合并匹配结果
//
// 依赖：
//   - log-analyzer.getLogStore / getCurrentLogSource（读取日志）
//   - ai-keys（API Key 轮询 + 模型配置）

const https = require('https');
const { StringDecoder } = require('string_decoder');

const logAnalyzer = require('./log-analyzer.cjs');
const aiKeys = require('./ai-keys.cjs');
const {
  AGNES_API_URL,
  AGNES_API_KEYS,
  AGNES_MODEL,
  getAgnesKeyIndex,
  getNextApiKey,
} = aiKeys;

const SMART_SEARCH_CHUNK_SIZE = 1000; // 每块 1000 条日志
const SMART_SEARCH_MAX_CONCURRENT = 3; // 最多并行 3 个分块

// 智能搜索状态
let smartSearchAbortController = null;
// 会话 ID：用于区分不同搜索会话，防止旧搜索的事件污染新搜索状态
let smartSearchSessionId = 0;

function register(ipcMain) {
  ipcMain.handle('smart-search:search', async (event, args) => {
    const { query, source } = args || {};
    if (!query || !query.trim()) {
      return { ok: false, error: tr("查询不能为空") };
    }

    const logStore = logAnalyzer.getLogStore();
    const currentLogSource = logAnalyzer.getCurrentLogSource();
    const entries = logStore[source || currentLogSource] || [];
    if (entries.length === 0) {
      return { ok: false, error: tr("没有可搜索的日志") };
    }

    // 中止上一次搜索
    if (smartSearchAbortController) {
      smartSearchAbortController.abort();
    }

    // 会话 ID：本次搜索的唯一标识，所有事件携带此 ID，渲染进程据此过滤旧会话事件
    // 防止"停止→重新搜索"时旧搜索的 complete/chunk/progress 事件污染新搜索状态
    const mySessionId = ++smartSearchSessionId;

    const sender = event.sender;

    // 分块 - 首块更小（200条），快速返回首批结果让用户3秒内看到变化
    const chunks = [];
    const FIRST_CHUNK_SIZE = 200; // 首块小，快速响应
    let firstChunkEnd = Math.min(entries.length, FIRST_CHUNK_SIZE);
    chunks.push({
      index: 0,
      start: 0,
      end: firstChunkEnd,
      entries: entries.slice(0, firstChunkEnd),
      priority: true
    });
    for (let i = firstChunkEnd; i < entries.length; i += SMART_SEARCH_CHUNK_SIZE) {
      const end = Math.min(entries.length, i + SMART_SEARCH_CHUNK_SIZE);
      chunks.push({
        index: chunks.length,
        start: i,
        end,
        entries: entries.slice(i, end)
      });
    }
    const totalChunks = chunks.length;

    // 通知渲染进程开始搜索
    if (!sender.isDestroyed()) {
      sender.send('smart-search:start', { sessionId: mySessionId, totalChunks, totalEntries: entries.length });
    }

    async function extractKeywordsWithAI(query) {
      const prompt = tr("从以下用户查询中提取用于日志搜索的关键词。\n\n只返回 JSON，不要其他内容：\n{\"keywords\":[\"关键词1\",\"关键词2\"]}\n\n规则：\n1. 只提取有实际搜索意义的关键词（技术术语、模块名、错误类型、组件名等）\n2. 过滤掉动词（查看、查找、显示）、时间词（当前、最近）、范围词（所有、相关）、通用名词（日志、记录）\n3. 英文关键词保留原样（如 ANR、Backlight、OOM）\n4. 中文关键词保留原样（如 亮度、背光、崩溃）\n5. 如果查询是纯英文技术术语，直接返回该术语\n6. 最多返回 5 个关键词\n\n用户查询：{0}", { 0: query });

      const requestBody = JSON.stringify({
        model: AGNES_MODEL,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        temperature: 0
      });

      return new Promise((resolve) => {
        const urlObj = new URL(AGNES_API_URL);
        const req = https.request({
          hostname: urlObj.hostname,
          port: 443,
          path: urlObj.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${AGNES_API_KEYS[getAgnesKeyIndex()]}`,
            'Accept': 'application/json'
          },
          timeout: 8000 // 8 秒超时，快速失败
        }, (res) => {
          if (res.statusCode !== 200) {
            resolve(null);
            res.resume();
            return;
          }
          let body = '';
          const decoder = new StringDecoder('utf8');
          res.on('data', (c) => { body += decoder.write(c); });
          res.on('end', () => {
            body += decoder.end();
            try {
              const json = JSON.parse(body);
              const content = json.choices?.[0]?.message?.content || '';
              const jsonMatch = content.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                const parsed = JSON.parse(jsonMatch[0]);
                resolve(parsed.keywords || []);
              } else {
                resolve(null);
              }
            } catch (e) {
              resolve(null);
            }
          });
        });
        req.on('timeout', () => { req.destroy(new Error('timeout')); });
        req.on('error', () => { resolve(null); });
        req.write(requestBody);
        req.end();
      });
    }

    // 先用 AI 提取关键词（快速，8秒超时），失败则用本地提取
    let queryKeywords = [];
    try {
      console.log(`[SmartSearch] 调用 AI 提取关键词: "${query}"`);
      const aiKeywords = await extractKeywordsWithAI(query);
      if (aiKeywords && aiKeywords.length > 0) {
        queryKeywords = aiKeywords;
        console.log(`[SmartSearch] AI 提取关键词成功:`, queryKeywords);
      } else {
        queryKeywords = extractKeywords(query);
        console.log(`[SmartSearch] AI 提取失败，使用本地提取:`, queryKeywords);
      }
    } catch (e) {
      queryKeywords = extractKeywords(query);
      console.log(`[SmartSearch] AI 提取异常，使用本地提取:`, queryKeywords);
    }

    // 构造系统 prompt - 优化 prompt 提高准确性
    const systemPrompt = tr("你是 Android 日志分析专家。用户会用自然语言描述想查找的日志内容，你需要在提供的日志块中找到所有匹配的行。\n\n任务：\n1. 仔细阅读每一行日志\n2. 找出所有与用户查询语义相关的行（包括同义词、关联词、错误堆栈等）\n3. 宁可多匹配也不要漏匹配\n\n返回严格的 JSON 格式（只返回 JSON，不要 markdown 代码块，不要其他文字）：\n{\"matchedLines\":[行号1,行号2],\"explanation\":\"说明\"}\n\n注意：\n- matchedLines 中的行号必须是日志行开头方括号中的数字，例如 [123] 则行号为 123\n- 如果没有匹配，返回 {\"matchedLines\":[],\"explanation\":\"未找到匹配\"}\n- 行号必须是整数，不要带引号");

    // 本地精确匹配：从查询中提取关键词，本地保证 100% 准确匹配
    // 即使 AI 漏掉，本地匹配也能兜底
    function extractKeywords(q) {
      // 扩展停用词：动词、时间词、疑问词、量词等无实际意义的词
      const stopWords = [
        // 助词/语气词
        '的', '了', '是', '在', '和', '就', '不', '也', '都', '着', '过', '吧', '呢', '啊', '吗',
        // 代词
        '我', '你', '他', '她', '它', '我们', '你们', '他们', '自己', '这', '那', '这个', '那个', '这些', '那些',
        // 量词/数词
        '一', '一个', '一些', '上', '下', '里', '中',
        // 疑问词
        '什么', '怎么', '如何', '哪些', '哪个', '为什么', '何时', '何地', '谁',
        // 动词（无实际日志意义的）
        '查看', '看', '找', '查找', '搜索', '搜', '查', '显示', '出现', '发生', '存在', '有', '没有', '无',
        '找出', '获取', '得到', '列出', '列举', '筛选', '过滤', '匹配',
        // 时间词
        '当前', '现在', '今天', '昨天', '最近', '之前', '之后', '刚才', '此时', '此时此刻',
        // 程度词
        '很', '非常', '特别', '比较', '最', '更', '太', '极',
        // 连接词
        '和', '与', '及', '或', '或者', '以及', '并', '并且', '但是', '但', '然而', '虽然', '尽管',
        // 范围词
        '所有', '相关', '全部', '全', '整个', '整体',
        // 通用名词
        '日志', '记录', '内容', '信息', '数据', '情况', '问题', '东西',
        // 介词
        '到', '去', '来', '向', '往', '从', '给', '对', '关于', '对于',
        // 其他
        '要', '会', '能', '可以', '应该', '需要', '希望', '想', '请', '麻烦'
      ];
      // 提取英文单词和中文词组
      const englishWords = q.match(/[a-zA-Z][a-zA-Z0-9_]*/g) || [];
      // 提取中文（2字以上）
      const chineseWords = q.match(/[\u4e00-\u9fa5]{2,}/g) || [];
      const allWords = [...englishWords, ...chineseWords];
      // 过滤停用词，过滤过短的词
      return allWords.filter(w => !stopWords.includes(w.toLowerCase()) && w.length >= 2);
    }

    // 本地匹配：使用 AND 逻辑（所有关键词都必须匹配），减少误报
    // 对于"查看当前调节亮度的log"，提取 ['调节', '亮度']，必须同时包含两者
    function localMatch(entries, keywords, startIdx) {
      const matched = new Set();
      if (keywords.length === 0) return matched;
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        const hay = `${e.raw || ''} ${e.tag || ''} ${e.message || ''} ${e.pkg || ''}`.toLowerCase();
        // AND 逻辑：所有关键词都必须匹配
        let allMatch = true;
        for (const kw of keywords) {
          if (!hay.includes(kw.toLowerCase())) {
            allMatch = false;
            break;
          }
        }
        if (allMatch) {
          matched.add(startIdx + i);
        }
      }
      return matched;
    }

    console.log(`[SmartSearch] 查询: "${query}", 最终关键词:`, queryKeywords, `(AND 逻辑)`);

    // 并行处理分块（最多 MAX_CONCURRENT 个同时）
    const results = [];
    let completedChunks = 0;

    async function searchChunk(chunk) {
      if (myController.signal.aborted) return null;

      // 构造日志文本
      const logText = chunk.entries.map((e, idx) => {
        const globalLine = chunk.start + idx;
        const ts = e.ts ? new Date(e.ts).toLocaleString('zh-CN', { hour12: false }) : '';
        return `[${globalLine}] ${ts} ${e.level || 'V'}/${e.tag || ''}(${e.pid || 0}): ${e.message || e.raw || ''}`;
      }).join('\n');

      const userContent = tr("用户查询：{0}\n\n日志内容（第 {1}/{2} 块，全局行号 {3}-{4}）：\n{5}", { 0: query, 1: chunk.index + 1, 2: totalChunks, 3: chunk.start, 4: chunk.end - 1, 5: logText });

      const requestBody = JSON.stringify({
        model: AGNES_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        stream: false,
        temperature: 0.1
      });

      return new Promise((resolve) => {
        const urlObj = new URL(AGNES_API_URL);
        let retryCount = 0;
        const AI_MAX_RETRIES = 3;
        const REQUEST_TIMEOUT_MS = 15000; // 单次请求超时 15 秒
        const RETRY_DELAY_MS = 1000; // 重试间隔 1 秒

        function doRequest(currentKey) {
          if (myController.signal.aborted) {
            resolve(null);
            return;
          }

          const req = https.request({
            hostname: urlObj.hostname,
            port: 443,
            path: urlObj.pathname,
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${currentKey}`,
              'Accept': 'application/json'
            },
            signal: myController.signal,
            timeout: REQUEST_TIMEOUT_MS
          }, (res) => {
            if (res.statusCode !== 200) {
              let errBody = '';
              res.on('data', (c) => { errBody += c; });
              res.on('end', () => {
                if (retryCount < AI_MAX_RETRIES && (res.statusCode === 429 || res.statusCode >= 500)) {
                  retryCount++;
                  console.warn(`[SmartSearch] 块 ${chunk.index} 状态码 ${res.statusCode}，第 ${retryCount} 次重试…`);
                  setTimeout(() => doRequest(getNextApiKey()), RETRY_DELAY_MS);
                  return;
                }
                console.error(`[SmartSearch] 块 ${chunk.index} API 错误: ${res.statusCode}`);
                resolve(null);
              });
              return;
            }

            let body = '';
            const decoder = new StringDecoder('utf8');
            res.on('data', (c) => { body += decoder.write(c); });
            res.on('end', () => {
              body += decoder.end();
              try {
                const json = JSON.parse(body);
                const content = json.choices?.[0]?.message?.content || '';
                // 提取 JSON
                const jsonMatch = content.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                  const parsed = JSON.parse(jsonMatch[0]);
                  resolve({
                    chunkIndex: chunk.index,
                    matchedLines: parsed.matchedLines || [],
                    explanation: parsed.explanation || ''
                  });
                } else {
                  if (retryCount < AI_MAX_RETRIES) {
                    retryCount++;
                    console.warn(`[SmartSearch] 块 ${chunk.index} 响应无 JSON，第 ${retryCount} 次重试…`);
                    setTimeout(() => doRequest(getNextApiKey()), RETRY_DELAY_MS);
                    return;
                  }
                  resolve({ chunkIndex: chunk.index, matchedLines: [], explanation: '' });
                }
              } catch (e) {
                if (retryCount < AI_MAX_RETRIES) {
                  retryCount++;
                  console.warn(`[SmartSearch] 块 ${chunk.index} 解析失败: ${e.message}，第 ${retryCount} 次重试…`);
                  setTimeout(() => doRequest(getNextApiKey()), RETRY_DELAY_MS);
                  return;
                }
                console.error(`[SmartSearch] 块 ${chunk.index} 解析失败（已耗尽重试）:`, e.message);
                resolve(null);
              }
            });
          });

          req.on('timeout', () => {
            req.destroy(new Error(tr("请求超时")));
          });

          req.on('error', (e) => {
            if (e.name === 'AbortError') {
              resolve(null);
              return;
            }
            if (retryCount < AI_MAX_RETRIES) {
              retryCount++;
              console.warn(`[SmartSearch] 块 ${chunk.index} 错误: ${e.message}，第 ${retryCount} 次重试…`);
              setTimeout(() => doRequest(getNextApiKey()), RETRY_DELAY_MS);
              return;
            }
            console.error(`[SmartSearch] 块 ${chunk.index} 网络错误（已耗尽重试）:`, e.message);
            resolve(null);
          });

          req.write(requestBody);
          req.end();
        }

        doRequest(AGNES_API_KEYS[getAgnesKeyIndex()]);
      });
    }

    // 用局部变量捕获 controller，防止 setTimeout 重试回调引用到被重置/替换的全局变量
    const myController = new AbortController();
    smartSearchAbortController = myController;

    // 并行执行，控制并发数 - 增量推送匹配结果，让用户感知进度
    const allMatchedLines = [];
    const explanations = [];

    // 改为：每个分块独立完成就立即推送，不等批次内其他分块
    // 使用信号量控制最大并发数，分块完成后立即推送结果
    let chunkIndex = 0;
    const concurrency = Math.min(SMART_SEARCH_MAX_CONCURRENT, chunks.length);

    async function runWorker() {
      while (chunkIndex < chunks.length && !myController.signal.aborted) {
        const myIndex = chunkIndex++;
        if (myIndex >= chunks.length) break;
        const chunk = chunks[myIndex];

        const localMatched = localMatch(chunk.entries, queryKeywords, chunk.start);

        const result = await searchChunk(chunk);

        if (myController.signal.aborted) return;

        const aiMatched = result?.matchedLines || [];
        const mergedMatched = new Set([...localMatched, ...aiMatched]);
        const matchedLines = Array.from(mergedMatched).sort((a, b) => a - b);

        if (matchedLines.length === 0) {
          completedChunks++;
          if (!sender.isDestroyed()) {
            sender.send('smart-search:progress', {
              sessionId: mySessionId,
              completed: completedChunks,
              total: totalChunks,
              matchedCount: allMatchedLines.length
            });
          }
          continue;
        }

        // 提取本批次匹配的日志条目（增量推送）
        const batchEntries = matchedLines
          .filter(idx => idx >= 0 && idx < entries.length)
          .map(idx => ({ ...entries[idx], _matchedLine: idx }));
        allMatchedLines.push(...matchedLines);
        if (result?.explanation && !explanations.includes(result.explanation)) {
          explanations.push(result.explanation);
        }
        completedChunks++;

        // 增量推送：每完成一个分块就发送匹配的条目，用户能看到结果逐步出现
        if (!sender.isDestroyed() && batchEntries.length > 0) {
          sender.send('smart-search:chunk', {
            sessionId: mySessionId,
            entries: batchEntries,
            completed: completedChunks,
            total: totalChunks,
            matchedCount: allMatchedLines.length
          });
        }

        if (!sender.isDestroyed()) {
          sender.send('smart-search:progress', {
            sessionId: mySessionId,
            completed: completedChunks,
            total: totalChunks,
            matchedCount: allMatchedLines.length
          });
        }
      }
    }

    // 启动多个 worker 并行处理
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(runWorker());
    }
    await Promise.all(workers);

    // 使用闭包内的 myController 检查中止状态，而非可能已被替换的全局变量
    const aborted = myController.signal.aborted;
    // 仅当全局变量仍指向自己的 controller 时才清理，避免清除了新搜索的 controller
    if (smartSearchAbortController === myController) {
      smartSearchAbortController = null;
    }

    // 排序匹配行号
    allMatchedLines.sort((a, b) => a - b);

    // 提取全部匹配的日志条目（最终完整结果）
    const matchedEntries = allMatchedLines
      .filter(idx => idx >= 0 && idx < entries.length)
      .map(idx => ({ ...entries[idx], _matchedLine: idx }));

    const result = {
      ok: true,
      query,
      sessionId: mySessionId,
      matchedCount: matchedEntries.length,
      matchedEntries,
      analysis: explanations.join('\n\n'),
      totalSearched: entries.length,
      aborted
    };

    // 中止后仍发送 complete 事件（渲染进程需要重置 smartSearching 状态），
    // 但渲染进程会通过 payload.aborted 判断是否使用结果
    if (!sender.isDestroyed()) {
      sender.send('smart-search:complete', result);
    }

    return result;
  });

  // 中止智能搜索
  ipcMain.handle('smart-search:stop', async () => {
    if (smartSearchAbortController) {
      smartSearchAbortController.abort();
      smartSearchAbortController = null;
    }
    return { ok: true };
  });
}

module.exports = { register };
