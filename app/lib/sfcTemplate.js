const path = require('path');

/**
 * 节点源码截断配置
 */
const NODE_SOURCE_MAX_LENGTH = 500;  // 最大字符数
const NODE_SOURCE_MAX_LINES = 10;    // 最大行数

/**
 * 截断过长的节点源码
 *
 * 📝 设计说明：
 * 对于带 v-for 的容器元素，getNodeSource 会返回整个循环块的内容（可能有几十行）。
 * 这会导致发送给 AI 的内容过大，触发 token 限制或超时。
 *
 * 截断策略：
 * 1. 如果源码超过最大长度或行数，只保留开标签
 * 2. 开标签提取方式：找到第一个 > 的位置
 *
 * @param {string} source - 原始节点源码
 * @returns {string} 截断后的源码
 */
function truncateNodeSource(source) {
  if (!source) return '';

  const lines = source.split('\n');
  const length = source.length;

  // 如果没有超过限制，直接返回
  if (length <= NODE_SOURCE_MAX_LENGTH && lines.length <= NODE_SOURCE_MAX_LINES) {
    return source;
  }

  // 超过限制：只保留开标签
  // 找到第一个 > 的位置（开标签结束）
  const firstTagEnd = source.indexOf('>');
  if (firstTagEnd === -1) {
    // 没找到 >，返回截断的源码
    return source.slice(0, NODE_SOURCE_MAX_LENGTH) + '\n  <!-- ... 内容已截断 -->';
  }

  // 提取开标签
  const openTag = source.slice(0, firstTagEnd + 1);

  // 检查是否是自闭合标签
  if (source.slice(firstTagEnd - 1, firstTagEnd + 1) === '/>') {
    return openTag;
  }

  // 找到标签名用于生成闭合标签
  const tagMatch = source.match(/^<([a-zA-Z][-a-zA-Z0-9]*)/);
  const tagName = tagMatch ? tagMatch[1] : '';

  if (tagName) {
    return `${openTag}\n  <!-- ... 子节点内容已省略（共 ${lines.length} 行） -->\n</${tagName}>`;
  }

  return openTag + '\n  <!-- ... 内容已截断 -->';
}

/**
 * 这个文件的目标：统一提供 "从 .vue 文件解析出 template AST" 的能力，并兼容 Vue2/Vue3 两套编译器。
 *
 * 背景：
 * - Vue3：@vue/compiler-sfc 解析 SFC，@vue/compiler-core baseParse(template) 得到 AST（节点带 loc）
 * - Vue2：vue-template-compiler compile(template, {outputSourceRange:true}) 得到 AST（节点带 start/end offset）
 *
 * 难点：
 * - Vue2 的 component-compiler-utils 会对 template.content 做 de-indent（去掉公共缩进），
 *   导致它不再是源码中 template 片段的原始子串。也就是说“文件 offset - templateStartOffset”
 *   不能直接得到 template.content 的 offset，需要用“按行换算 + 缩进补偿”。
 */

/** 
  * 补充：为什么不直接用 Vue3 的 @vue/compiler-core 解析 Vue2？
  * 1. 语法兼容性：Vue2 包含一些 Vue3 已废弃的语法（如：过滤器 Filter `|`、inline-template 等），
  *    Vue3 编译器在遇到这些语法时可能报错或解析结果不符合预期。
  * 2. AST 结构差异：两者的 AST 节点定义（Property Name、Node Types）完全不同。Vue3 引入了大量
  *    为了静态提升（hoisting）和 PatchFlag 优化的属性，而 Vue2 的 AST 结构相对扁平且简单。
  * 3. 结果一致性：本工具（FluxTrace）的目标是还原真实的线上运行逻辑。既然 Vue2 项目在构建时
  *    使用的是 vue-template-compiler，我们必须使用同样的编译器，以确保得到的 AST 结构、
  *    指令解析顺序与项目实际运行时完全吻合，避免“分析结果”与“实际运行”存在偏差。
  */

function computeLineStartOffsets(source) {
  const lineStartOffsets = [0];
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lineStartOffsets.push(i + 1);
  }
  return lineStartOffsets;
}

function lineColToOffset(lineStartOffsets, line1, column0) {
  const lineIndex = Math.max(0, line1 - 1);
  const lineStart = lineStartOffsets[lineIndex] ?? 0;
  return lineStart + Math.max(0, column0);
}

function normalizeLineColumn(source, line1, column0) {
  /**
   * 目的：把“可能越界/落在行尾空白”的 column 拉回到本行的有效范围内，
   * 避免因为 column 超出行长而在 offset 推导时跨行，导致定位到下一行的节点。
   */
  const lineStartOffsets = computeLineStartOffsets(source);
  const lineIndex = Math.max(0, line1 - 1);
  const lineStart = lineStartOffsets[lineIndex] ?? 0;
  const nextLineStart = lineStartOffsets[lineIndex + 1];
  const lineEnd = typeof nextLineStart === 'number' ? Math.max(lineStart, nextLineStart - 1) : source.length;
  const lineText = source.slice(lineStart, lineEnd);
  const lineLength = Math.max(0, lineText.length);

  if (lineLength === 0) return { line: line1, column: 0 };

  let lastNonWhitespaceIndex = lineLength - 1;
  while (lastNonWhitespaceIndex >= 0) {
    const ch = lineText.charCodeAt(lastNonWhitespaceIndex);
    if (ch !== 32 && ch !== 9 && ch !== 13) break;
    lastNonWhitespaceIndex--;
  }
  if (lastNonWhitespaceIndex < 0) lastNonWhitespaceIndex = 0;

  const col = Math.max(0, Math.min(column0, lastNonWhitespaceIndex));
  return { line: line1, column: col };
}

function offsetToLineCol(source, offset) {
  // 把 source 内的字符 offset 反解成 (line=1-based, column=0-based)
  const safeOffset = Math.max(0, Math.min(source.length, offset));
  let line = 1;
  let lastLineStart = 0;
  for (let i = 0; i < safeOffset; i++) {
    if (source.charCodeAt(i) === 10) {
      line++;
      lastLineStart = i + 1;
    }
  }
  return { line, column: safeOffset - lastLineStart };
}

function extractTemplateBlock(source) {
  /**
   * 早期实现用正则从源码里截取 <template>...</template>。
   * 但 Vue2 模板内部常有嵌套 <template slot="...">，正则会误匹配第一个 </template>，
   * 所以现在 Vue2 分支不再使用它；保留这个函数是为了兼容其它场景/后续扩展。
   */
  const match = source.match(/<template\b[^>]*>([\s\S]*?)<\/template>/i);
  if (!match) return null;
  const templateSource = match[1];
  const startOffset = match.index + match[0].indexOf(templateSource);
  const endOffset = startOffset + templateSource.length;
  return { templateSource, startOffset, endOffset };
}

function getVueMajor(projectRoot) {
  // 通过 node_modules/vue/package.json 读取主版本号，用于默认选择 Vue2 还是 Vue3 解析器
  try {
    const vuePkg = require(path.resolve(projectRoot, 'node_modules/vue/package.json'));
    const version = vuePkg && typeof vuePkg.version === 'string' ? vuePkg.version : '';
    const major = parseInt(version.split('.')[0], 10);
    if (Number.isFinite(major)) return major;
  } catch (e) { }
  return null;
}

function parseVue3Template(fileContent) {
  // Vue3：SFC 解析 + baseParse 得到 template AST（带 loc）
  const { parse } = require('@vue/compiler-sfc');
  const { baseParse } = require('@vue/compiler-core');
  const { descriptor } = parse(fileContent);
  if (!descriptor || !descriptor.template) return null;
  const templateSource = descriptor.template.content;
  const templateAST = baseParse(templateSource);
  return {
    kind: 'vue3',
    descriptor,
    templateSource,
    templateAST,
    getNodeSource(node) {
      const source = node?.loc?.source || '';
      return truncateNodeSource(source);
    },
  };
}

function parseVue2Template(fileContent, filename) {
  /**
   * Vue2：用 @vue/component-compiler-utils 解析 SFC，然后用 vue-template-compiler.compile 生成 template AST。
   *
   * 关键点：descriptor.template.content 会被 de-indent（去掉最小公共缩进）
   * - AST 的 start/end offset 是相对于“de-indent 后的 template.content”
   * - 但我们收到的点击坐标是相对于“原文件 fileContent”
   *
   * 因此我们要额外计算：
   * - templateStartLoc：template 内容在原文件中的起始 (line,column)
   * - templateBaseIndent：原文件 template 片段的公共缩进，用于把 file column 映射到 de-indent 后的 column
   */
  const compiler = require('vue-template-compiler');
  const { parse } = require('@vue/component-compiler-utils');
  const descriptor = parse({
    source: fileContent,
    compiler,
    filename,
    needMap: false,
  });
  if (!descriptor || !descriptor.template) return null;
  const templateSource = descriptor.template.content;
  const templateStartOffset = descriptor.template.start;
  const templateEndOffset = descriptor.template.end;
  // 原始的 template 字符串
  const rawTemplateSource = fileContent.slice(templateStartOffset, templateEndOffset);

  let templateBaseIndent = 0;
  const lines = rawTemplateSource.split(/\r?\n/);
  let minIndent = Infinity;
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    const match = line.match(/^\s+/);
    const indent = match ? match[0].length : 0;
    if (indent < minIndent) minIndent = indent;
  }
  if (Number.isFinite(minIndent) && minIndent !== Infinity) templateBaseIndent = minIndent;

  const templateStartLoc = offsetToLineCol(fileContent, templateStartOffset);

  const { ast } = compiler.compile(templateSource, { outputSourceRange: true });
  if (!ast) return null;

  return {
    kind: 'vue2',
    descriptor,
    templateSource,
    templateAST: ast,
    templateStartOffset,
    templateEndOffset,
    rawTemplateSource,
    templateBaseIndent,
    templateStartLoc,
    getNodeSource(node) {
      if (!node || typeof node.start !== 'number' || typeof node.end !== 'number') return '';
      const source = templateSource.slice(node.start, node.end);
      return truncateNodeSource(source);
    },
  };
}

function parseSfcTemplate({ projectRoot, fileContent, filename }) {
  /**
   * 选择解析器策略：
   * - 默认根据项目 vue 主版本选择（Vue2 优先 / Vue3 优先）
   * - 可通过环境变量 FLUX_TRACE_VUE=2|3 强制指定
   */
  const forced = process.env.FLUX_TRACE_VUE;
  const vueMajor = getVueMajor(projectRoot);
  const preferVue2 = forced === '2' || (forced !== '3' && vueMajor === 2);

  if (preferVue2) {
    const vue2 = parseVue2Template(fileContent, filename);
    if (vue2) return vue2;
  }

  const vue3 = parseVue3Template(fileContent);
  if (vue3) return vue3;

  if (!preferVue2) {
    const vue2 = parseVue2Template(fileContent, filename);
    if (vue2) return vue2;
  }

  return null;
}

function locateTemplatePosition({ fileContent, templateStartOffset, fileLine, fileColumn }) {
  /**
   * 这个函数是“基于 offset 差值”的定位方式，对 Vue3/原样 template 片段是可行的，
   * 但对 Vue2 de-indent 后的 templateSource 不可靠。保留用于历史/其它用途。
   */
  const fileLineStartOffsets = computeLineStartOffsets(fileContent);
  const fileOffset = lineColToOffset(fileLineStartOffsets, fileLine, fileColumn);
  const templateOffset = Math.max(0, fileOffset - (templateStartOffset || 0));
  return offsetToLineCol(fileContent.slice(templateStartOffset || 0), templateOffset);
}

module.exports = {
  computeLineStartOffsets,
  lineColToOffset,
  offsetToLineCol,
  normalizeLineColumn,
  extractTemplateBlock,
  parseSfcTemplate,
  locateTemplatePosition,
};
