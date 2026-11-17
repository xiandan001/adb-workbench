const { tr } = require('./localization.cjs');
const letter = code => code >= 65 && code <= 90 || code >= 97 && code <= 122;
const digit = code => code >= 48 && code <= 57;
const word = code => letter(code) || digit(code) || code === 95;
const scheme = code => letter(code) || digit(code) || code === 43 || code === 45 || code === 46;
const local = code => word(code) || [46, 37, 43, 45].includes(code);
const domain = code => letter(code) || digit(code) || code === 45 || code === 46;
const space = char => /\s/u.test(char);

function redactUrls(text) {
  if (!text.includes('@') || !text.includes('://')) return text;
  const parts = []; let cursor = 0, copied = 0;
  for (;;) {
    const delimiter = text.indexOf('://', cursor); if (delimiter < 0) break;
    let start = delimiter, end = delimiter + 3, at = -1, colon = -1;
    while (start > 0 && scheme(text.charCodeAt(start - 1))) start--;
    while (start < delimiter && !letter(text.charCodeAt(start))) start++;
    while (end < text.length && text[end] !== '/' && !space(text[end])) {
      if (at < 0 && text[end] === '@') at = end;
      if (colon < 0 && end > delimiter + 3 && text[end] === ':') colon = end;
      end++;
    }
    if (start < delimiter && at >= 0 && at < end && colon > delimiter + 3 && colon < at - 1) {
      parts.push(text.slice(copied, delimiter + 3), tr('$1[凭据已隐藏]@').replace('$1', '')); copied = at + 1; cursor = at + 1;
    } else cursor = delimiter + 3;
  }
  return parts.length ? parts.join('') + text.slice(copied) : text;
}

function redactEmails(text) {
  if (!text.includes('@')) return text;
  const parts = []; let cursor = 0, copied = 0;
  for (;;) {
    const at = text.indexOf('@', cursor); if (at < 0) break;
    let start = at, end = at + 1, matchEnd = -1;
    while (start > copied && local(text.charCodeAt(start - 1))) start--;
    while (start < at && !word(text.charCodeAt(start))) start++;
    while (end < text.length && domain(text.charCodeAt(end))) end++;
    for (let dot = at + 2; dot < end; dot++) {
      if (text[dot] !== '.') continue;
      let tail = dot + 1; while (tail < end && letter(text.charCodeAt(tail))) tail++;
      if (tail - dot > 2 && !word(text.charCodeAt(tail))) matchEnd = tail;
      dot = tail - 1;
    }
    if (start < at && matchEnd >= 0) {
      parts.push(text.slice(copied, start), tr('[邮箱已隐藏]')); copied = matchEnd; cursor = matchEnd;
    } else cursor = at + 1;
  }
  return parts.length ? parts.join('') + text.slice(copied) : text;
}

function redactFields(text, quoted) {
  const keys = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|authorization|cookie|token|密码|激活码)/gi;
  const parts = []; let copied = 0, match;
  while ((match = keys.exec(text))) {
    let value = keys.lastIndex;
    while (value < text.length && space(text[value])) value++;
    if (text[value] === '"' || text[value] === "'") value++;
    while (value < text.length && space(text[value])) value++;
    if (text[value] !== ':' && text[value] !== '=') continue;
    value++; while (value < text.length && space(text[value])) value++;
    let end = value;
    if (quoted) {
      const quote = text[value]; if (quote !== '"' && quote !== "'") continue;
      end++;
      while (end < text.length && text[end] !== quote) { if (text[end] === '\\') end++; end++; }
      if (end >= text.length) continue;
      end++;
    } else {
      while (end < text.length && !space(text[end]) && !',;"\'<>'.includes(text[end])) end++;
      if (end === value) continue;
    }
    parts.push(text.slice(copied, value), (quoted ? tr('$1"[已隐藏]"') : tr('$1[已隐藏]')).replace('$1', ''));
    copied = end; keys.lastIndex = end;
  }
  return parts.length ? parts.join('') + text.slice(copied) : text;
}

function redactJwt(text) {
  const starts = /\beyJ/g, token = code => word(code) || code === 45;
  const parts = []; let copied = 0, match;
  while ((match = starts.exec(text))) {
    let cursor = starts.lastIndex, valid = true;
    for (let segment = 0; segment < 3; segment++) {
      const begin = cursor; while (cursor < text.length && token(text.charCodeAt(cursor))) cursor++;
      let end = cursor;
      if (segment === 2) while (end > begin && !word(text.charCodeAt(end - 1))) end--;
      if (end - begin < 8 || segment < 2 && text[cursor] !== '.') { valid = false; break; }
      if (segment < 2) cursor++; else cursor = end;
    }
    if (valid) { parts.push(text.slice(copied, match.index), tr('[令牌已隐藏]')); copied = cursor; }
    starts.lastIndex = cursor;
  }
  return parts.length ? parts.join('') + text.slice(copied) : text;
}

function redactWorkspaceText(value) {
  let text = String(value)
    .replace(/-----BEGIN [A-Z\d ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z\d ]*PRIVATE KEY-----|$)/g, tr('[私钥已隐藏]'))
    .replace(/\b(?:github_pat_[A-Za-z\d_]{10,}|gh[pousrf]_[A-Za-z\d_]{10,}|sk-[A-Za-z\d_-]{10,})\b/g, tr('[密钥已隐藏]'))
    .replace(/\bBearer\s+[^\s"'<>]+/gi, tr('Bearer [已隐藏]'));
  text = redactFields(redactFields(text, true), false);
  text = redactUrls(text);
  text = text.replace(/\b[A-Z]:[\\/][^\s"'<>]*/gi, tr('[本地路径已隐藏]'))
    .replace(/\\\\[^\s"'<>]+/g, tr('[网络路径已隐藏]'))
    .replace(/\/(?:home|Users)\/[^\s"'<>]+/g, tr('[用户路径已隐藏]'));
  text = redactEmails(text).replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, match => match.split('.').every(part => Number(part) <= 255) ? tr('[IP已隐藏]') : match);
  return redactJwt(text).replace(/\r\n?/g, '\n');
}

module.exports = { redactWorkspaceText };
