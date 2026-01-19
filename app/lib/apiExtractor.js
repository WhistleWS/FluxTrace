'use strict';

const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generate = require('@babel/generator').default;

/**
 * 接口调用证据提取器（第六层 api_info 的数据来源）
 *
 * 为什么需要它：
 * - 以前仅靠正则匹配 request('/api/xx', METHOD.GET)，覆盖面太窄，且很难适配团队的二次封装。
 * - 这里使用 Babel AST 扫描每一层 prunedScript，提取“疑似发起请求/接口调用”的证据列表，
 *   作为 Prompt 第六层的输入，让模型基于证据做判断，而不是纯猜测。
 *
 * 能识别的常见形态（按可信度从高到低）：
 * 1) 真实 URL 证据（可判定 API）：
 *    - request('/api/xx', METHOD.GET)
 *    - request({ url: '/api/xx', method: METHOD.POST })
 *    - axios.get('/api/xx') / axios.post('/api/xx')
 *    - axios({ url: '/api/xx', method: 'post' })
 *    - fetch('/api/xx', { method: 'PUT' })
 *    - this.$https.get('/api/xx') / this.$http.post('/api/xx')（项目里常见的 this.$xxx 封装）
 * 2) 符号化 endpoint（仅能证明“像是在调用接口”，但无法还原真实 URL）：
 *    - this.$apis.user.list(params) -> endpoint='$apis.user.list'，method=UNKNOWN
 *
 * 输出字段说明：
 * - endpoint：真实 URL 或符号化 endpoint；无法判断时为 null
 * - method：推断出的 HTTP 方法；无法判断时为 UNKNOWN
 * - evidence：调用表达式的短代码片段（用于 Prompt 引用证据）
 * - confidence：high/medium/low（用于排序与提示）
 */

function toMethodFromPropertyName(name) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  const map = {
    get: 'GET',
    post: 'POST',
    put: 'PUT',
    delete: 'DELETE',
    del: 'DELETE',
    patch: 'PATCH',
    head: 'HEAD',
    options: 'OPTIONS',
  };
  return map[lower] || null;
}

function safeGenerate(node) {
  try {
    return generate(node, { comments: false, compact: true }).code;
  } catch (_) {
    return '';
  }
}

/**
 * 只对“确定可读”的字符串形态取值：
 * - StringLiteral：直接取 value
 * - TemplateLiteral：保留模板表达式本体（作为证据而非最终 URL）
 */
function getStringLikeValue(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral') return safeGenerate(node);
  return null;
}

/**
 * 在 ObjectExpression 里读取指定 key 的 value，例如：
 * - request({ url: '/api/xx', method: 'post' })
 * - fetch('/api/xx', { method: 'PUT' })
 */
function getObjectPropertyValue(objExpr, keyName) {
  if (!objExpr || objExpr.type !== 'ObjectExpression') return null;
  for (const prop of objExpr.properties) {
    if (prop.type !== 'ObjectProperty') continue;
    const key =
      prop.key?.type === 'Identifier' ? prop.key.name :
      prop.key?.type === 'StringLiteral' ? prop.key.value :
      null;
    if (key !== keyName) continue;
    return prop.value;
  }
  return null;
}

/**
 * 把 MemberExpression 还原成点路径数组，便于统一匹配：
 * - this.$https.get -> ['this', '$https', 'get']
 * - this.$apis.user.list -> ['this', '$apis', 'user', 'list']
 * - axios.get -> ['axios', 'get']
 */
function flattenMemberExpression(node) {
  const parts = [];
  let curr = node;
  while (curr && curr.type === 'MemberExpression') {
    if (curr.property) {
      if (curr.property.type === 'Identifier') parts.unshift(curr.property.name);
      else if (curr.property.type === 'StringLiteral') parts.unshift(curr.property.value);
      else parts.unshift(safeGenerate(curr.property));
    }
    curr = curr.object;
  }
  if (curr) {
    if (curr.type === 'ThisExpression') parts.unshift('this');
    else if (curr.type === 'Identifier') parts.unshift(curr.name);
    else parts.unshift(safeGenerate(curr));
  }
  return parts.filter(Boolean);
}

/**
 * 对 this.$apis / this.$api 这类封装输出“符号化 endpoint”，例如：
 * - this.$apis.user.list -> '$apis.user.list'
 * 说明：该 endpoint 并非真实 URL，仅作为“接口调用证据”。
 */
function toSymbolicEndpointFromParts(parts) {
  const idx = parts.findIndex(p => p === '$apis' || p === '$api');
  if (idx === -1) return null;
  return parts.slice(idx).join('.');
}

/**
 * 判断是否为 this.$xxx 的封装调用（例如 this.$http / this.$https / this.$axios）。
 * 这类调用通常第一个参数仍然是 url，因此我们可以提取出真实 endpoint。
 */
function isThisDollarWrapper(parts) {
  return parts.length >= 2 && parts[0] === 'this' && typeof parts[1] === 'string' && parts[1].startsWith('$');
}

function buildEvidence({ file, line, callee, endpoint, method, confidence, evidence }) {
  return {
    file: file || 'unknown',
    line: Number.isFinite(line) ? line : null,
    callee: callee || null,
    endpoint: endpoint || null,
    method: method || 'UNKNOWN',
    confidence: confidence || 'low',
    evidence: evidence || null,
  };
}

function normalizeEndpoint(endpoint) {
  if (!endpoint) return null;
  const trimmed = String(endpoint).trim();
  return trimmed.length ? trimmed : null;
}

function normalizeMethod(method) {
  if (!method) return 'UNKNOWN';
  const raw = String(method).trim();
  if (!raw) return 'UNKNOWN';

  // 兼容 method='get'/'post' 这种小写字符串
  const direct = toMethodFromPropertyName(raw);
  if (direct) return direct;

  const upper = raw.toUpperCase();
  const allowed = new Set([ 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS' ]);
  if (allowed.has(upper)) return upper;

  // 兼容 METHOD.GET / http.METHOD_POST / 'METHOD.GET' 等“包含方法单词”的表达式
  const match = upper.match(/\b(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/);
  if (match && allowed.has(match[1])) return match[1];

  return 'UNKNOWN';
}

function pickConfidence({ endpoint, method, symbolic }) {
  const hasEndpoint = Boolean(endpoint);
  const hasMethod = method && method !== 'UNKNOWN';
  if (symbolic) return 'medium';
  if (hasEndpoint && hasMethod) return 'high';
  if (hasEndpoint || hasMethod) return 'medium';
  return 'low';
}

function parseScript(code) {
  return parser.parse(code, {
    sourceType: 'unambiguous',
    plugins: [ 'typescript', 'jsx', 'classProperties', 'decorators-legacy' ],
    errorRecovery: true,
    allowReturnOutsideFunction: true,
  });
}

/**
 * 从 traceChain（按溯源链路的每一层）中提取接口调用证据。
 *
 * 设计取舍：
 * - 只扫描 prunedScript（已提纯）以降低噪声与 Token 成本。
 * - 只要出现“像请求”的调用就收集证据，但会给出 confidence 区分。
 * - 对 $apis 这类“方法映射封装”，只能得到符号化 endpoint，禁止冒充真实 URL。
 */
function extractApiEvidence({ traceChain }) {
  const results = [];
  const seen = new Set();

  if (!Array.isArray(traceChain)) return [];

  for (const step of traceChain) {
    const file = step?.file;
    const code = step?.prunedScript;
    if (!code || typeof code !== 'string') continue;

    let ast;
    try {
      ast = parseScript(code);
    } catch (_) {
      continue;
    }

    traverse(ast, {
      CallExpression(path) {
        const node = path.node;
        const callee = node.callee;
        const line = node.loc?.start?.line;

        // 证据片段：用于 Prompt 引用，避免把整段源码喂给模型
        const evidenceCode = safeGenerate(node).slice(0, 240);

        let endpoint = null;
        let method = 'UNKNOWN';
        let calleeStr = null;
        let symbolic = false;

        if (callee.type === 'Identifier') {
          calleeStr = callee.name;

          // fetch(url, { method })：method 只能从第二个参数 options.method 推断
          if (callee.name === 'fetch') {
            endpoint = getStringLikeValue(node.arguments[0]);
            const options = node.arguments[1];
            const methodNode = getObjectPropertyValue(options, 'method');
            const methodValue = getStringLikeValue(methodNode) || safeGenerate(methodNode);
            method = normalizeMethod(methodValue);
          }

          // request('/api/xx', METHOD.GET) / request({ url, method })
          if (callee.name === 'request') {
            endpoint = getStringLikeValue(node.arguments[0]);
            const second = node.arguments[1];
            if (second) {
              const m = safeGenerate(second);
              method = normalizeMethod(m);
            }

            const first = node.arguments[0];
            if (first && first.type === 'ObjectExpression') {
              const urlNode = getObjectPropertyValue(first, 'url');
              const methodNode = getObjectPropertyValue(first, 'method');
              endpoint = getStringLikeValue(urlNode) || safeGenerate(urlNode);
              const methodValue = getStringLikeValue(methodNode) || safeGenerate(methodNode);
              method = normalizeMethod(methodValue);
            }
          }
        } else if (callee.type === 'MemberExpression') {
          const parts = flattenMemberExpression(callee);
          calleeStr = parts.join('.');

          // this.$apis.xx.yy：符号化 endpoint，仅提供“疑似接口调用”的证据
          const maybeSymbolic = toSymbolicEndpointFromParts(parts);
          if (maybeSymbolic) {
            endpoint = maybeSymbolic;
            symbolic = true;
          }

          const last = parts[parts.length - 1];
          const inferred = toMethodFromPropertyName(last);
          if (inferred) method = inferred;

          const base = parts[0];
          const second = parts[1];
          const isAxios = base === 'axios';
          // this.$https.get('/api/xx') / this.$http.post('/api/xx') 这类封装（白名单）
          const isFetchLike = isThisDollarWrapper(parts) && [ '$http', '$https', '$axios', '$request' ].includes(second);

          if (isAxios || isFetchLike) {
            const firstArg = node.arguments[0];
            const secondArg = node.arguments[1];

            endpoint = normalizeEndpoint(getStringLikeValue(firstArg) || endpoint);

            // axios.get('/api/xx', { method }) 的 method 仅作为补充（大多数时候方法来自 .get/.post）
            if (secondArg && secondArg.type === 'ObjectExpression') {
              const methodNode = getObjectPropertyValue(secondArg, 'method');
              const methodValue = getStringLikeValue(methodNode) || safeGenerate(methodNode);
              const normalized = normalizeMethod(methodValue);
              if (normalized !== 'UNKNOWN') method = normalized;
            }

            // axios({ url, method }) / this.$https({ url, method })
            if (firstArg && firstArg.type === 'ObjectExpression') {
              const urlNode = getObjectPropertyValue(firstArg, 'url');
              const methodNode = getObjectPropertyValue(firstArg, 'method');
              endpoint = normalizeEndpoint(getStringLikeValue(urlNode) || safeGenerate(urlNode) || endpoint);
              const methodValue = getStringLikeValue(methodNode) || safeGenerate(methodNode);
              const normalized = normalizeMethod(methodValue);
              if (normalized !== 'UNKNOWN') method = normalized;
            }
          }
        }

        endpoint = normalizeEndpoint(endpoint);
        method = normalizeMethod(method);

        if (!endpoint && method === 'UNKNOWN') return;

        const confidence = pickConfidence({ endpoint, method, symbolic });

        const item = buildEvidence({
          file,
          line,
          callee: calleeStr,
          endpoint,
          method,
          confidence,
          evidence: evidenceCode || null,
        });

        const key = `${item.file}|${item.method}|${item.endpoint}|${item.callee}|${item.line}`;
        if (seen.has(key)) return;
        seen.add(key);
        results.push(item);
      },
    });
  }

  const methodWeight = m => {
    const order = { GET: 1, POST: 2, PUT: 3, DELETE: 4, PATCH: 5, UNKNOWN: 6 };
    return order[m] || 99;
  };

  results.sort((a, b) => {
    const aSymbolic = a.endpoint && (a.endpoint.startsWith('$apis') || a.endpoint.startsWith('$api'));
    const bSymbolic = b.endpoint && (b.endpoint.startsWith('$apis') || b.endpoint.startsWith('$api'));
    // 真实 URL 优先；符号化 endpoint 放后面，避免误导模型
    if (aSymbolic !== bSymbolic) return aSymbolic ? 1 : -1;
    return methodWeight(a.method) - methodWeight(b.method);
  });

  return results;
}

module.exports = { extractApiEvidence };
