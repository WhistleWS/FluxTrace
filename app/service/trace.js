/**
 * Trace Service：核心溯源逻辑
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 🎯 核心功能：从用户点击位置反向追踪数据来源
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 📚 技术背景：什么是数据溯源？
 *
 * 用户在页面上点击一个元素（如显示金额的 <span>），我们需要回答：
 * - 这个数据是从哪里来的？
 * - 经过了哪些组件的传递？
 * - 最终的数据源是 API、Vuex 还是写死的？
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 📊 完整追踪流程图：
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  用户点击：<span>{{ amount }}</span>                        │
 *   │  位置：src/views/Dashboard.vue 第 42 行                     │
 *   └─────────────────────────────────────────────────────────────┘
 *                           │
 *                           ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Step 1: 解析 Vue 文件，定位 AST 节点                       │
 *   │  使用 templateAST.js 的 findNodeInTemplate                 │
 *   └─────────────────────────────────────────────────────────────┘
 *                           │
 *                           ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Step 2: 提取变量                                           │
 *   │  使用 variableAST.js 的 getUniversalVariables              │
 *   │  结果：['amount']                                           │
 *   └─────────────────────────────────────────────────────────────┘
 *                           │
 *                           ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Step 3: 代码提纯                                           │
 *   │  使用 scriptAST.js 的 pruneScript                          │
 *   │  只保留与 amount 相关的代码                                 │
 *   └─────────────────────────────────────────────────────────────┘
 *                           │
 *                           ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Step 4: 判断数据来源                                       │
 *   │  - 来自 props？ → 继续追踪父组件                            │
 *   │  - 来自 Vuex？  → 追踪 Store 定义                           │
 *   │  - 来自 data？  → 追踪赋值语句                              │
 *   └─────────────────────────────────────────────────────────────┘
 *                           │
 *              ┌────────────┴────────────┐
 *              ▼                         ▼
 *   ┌──────────────────┐      ┌──────────────────────────────────┐
 *   │  来自 props      │      │  找到数据源（API/Vuex/静态）     │
 *   │  ↓               │      │  → 结束追踪                      │
 *   │  查找父组件      │      └──────────────────────────────────┘
 *   │  (WebpackService)│
 *   │  ↓               │
 *   │  回到 Step 1     │
 *   └──────────────────┘
 *                           │
 *                           ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Step 5: 构建追踪链                                         │
 *   │  traceChain = [子组件信息, 父组件信息, ...]                │
 *   └─────────────────────────────────────────────────────────────┘
 *                           │
 *                           ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  Step 6: 调用 AI 分析                                       │
 *   │  把提纯后的代码发给大模型，生成结构化分析报告               │
 *   └─────────────────────────────────────────────────────────────┘
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 📊 追踪链示例：
 *
 *   用户点击 ChartCard 组件中的 amount：
 *
 *   traceChain = [
 *     {
 *       file: 'src/components/ChartCard.vue',
 *       tag: 'span',
 *       source: '<span>{{ amount }}</span>',
 *       prunedScript: 'props: { amount: Number }',
 *       callSnippet: ''
 *     },
 *     {
 *       file: 'src/views/Dashboard.vue',
 *       tag: 'ChartCard',
 *       source: '<ChartCard :amount="totalAmount" />',
 *       prunedScript: 'computed: { totalAmount() { return this.data.amount } }',
 *       callSnippet: '<ChartCard :amount="totalAmount" />'
 *     }
 *   ]
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */

'use strict';

const Service = require('egg').Service;
const fs = require('fs');
const path = require('path');

const { findNodeInTemplate } = require('../lib/templateAST');
const { pruneScript } = require('../lib/scriptAST');
const { getUniversalVariables, getCategorizedVariables } = require('../lib/variableAST');
const webpackService = require('../lib/WebpackService');
const {
  isFromProps,
  findBindingInParent,
  findVuexDefinition,
  getVuexSource,
  findMutationTriggers,
} = require('../lib/utils/traceUtils');
const { parseSfcTemplate, normalizeLineColumn } = require('../lib/sfcTemplate');

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 常量定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 最大追踪深度
 * 防止循环引用导致无限循环
 */
const MAX_TRACE_DEPTH = 10;

/**
 * 变量分类类型
 */
const CATEGORY_TYPES = ['content', 'attributes', 'conditionals'];

/**
 * 分类显示名称映射
 */
const CATEGORY_LABELS = {
  content: '📊 内容变量追踪链 (content)',
  attributes: '🎨 属性变量追踪链 (attributes)',
  conditionals: '🔀 条件变量追踪链 (conditionals)',
};

class TraceService extends Service {
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SFC 缓存机制
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * 带缓存的 SFC 解析
   *
   * 📝 设计说明：
   * 多链路追踪时，同一个父组件可能被多个分类链路访问，导致重复解析。
   * 通过请求级缓存，确保每个文件在单次请求中只解析一次。
   *
   * 📊 性能提升示例：
   *   用户点击元素有 3 个变量，都来自 props，追踪链深度 = 3
   *   优化前：13 次解析（每个分类每层都解析）
   *   优化后：3 次解析（每个文件只解析一次）
   *
   * @param {string} fullPath - 文件绝对路径
   * @param {Map} cache - 请求级缓存 Map<absolutePath, {parsed, fileContent}>
   * @param {Object} parseOptions - 解析选项
   * @param {string} parseOptions.projectRoot - 项目根目录
   * @param {string} parseOptions.filename - 相对文件名
   * @returns {Object} { parsed, fileContent }
   */
  getCachedParsedSfc(fullPath, cache, parseOptions) {
    // 缓存命中：直接返回
    if (cache.has(fullPath)) {
      this.ctx.logger.info(`[SFC Cache] HIT: ${path.basename(fullPath)}`);
      return cache.get(fullPath);
    }

    // 缓存未命中：解析文件并缓存
    this.ctx.logger.info(`[SFC Cache] MISS: ${path.basename(fullPath)}`);

    const fileContent = fs.readFileSync(fullPath, 'utf-8');
    const parsed = parseSfcTemplate({
      projectRoot: parseOptions.projectRoot,
      fileContent,
      filename: parseOptions.filename,
    });

    const cacheEntry = { parsed, fileContent };
    cache.set(fullPath, cacheEntry);

    return cacheEntry;
  }

  /**
   * 分析入口：从用户点击位置溯源到数据源头，并调用大模型生成结构化分析
   * @param {Object} params
   * @param {string} params.path 相对项目根目录的 Vue 文件路径
   * @param {number} params.line 1-based 行号
   * @param {number} params.column 0-based 列号
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * 📝 参数说明
   *
   * 这些参数来自前端的 code-inspector-plugin 插件：
   * - path: 用户点击的元素所在的 Vue 文件路径
   * - line: 元素在文件中的行号（从 1 开始）
   * - column: 元素在行中的列号（从 0 开始）
   *
   * 📊 示例：
   *   用户点击了 src/views/Dashboard.vue 第 42 行的一个 span
   *   参数：{ path: 'src/views/Dashboard.vue', line: 42, column: 8 }
   * ═══════════════════════════════════════════════════════════════════════════
   */
  async analyze({ path: currentRelativePath, line, column }) {
    const { ctx, app } = this;

    // 项目根目录（用于拼接完整路径）
    const projectRoot = app.config.projectRoot;

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Phase 1: 读取并解析 Vue 文件
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const fullPath = path.join(projectRoot, currentRelativePath);
    if (!fs.existsSync(fullPath)) {
      return { message: '文件不存在', path: currentRelativePath };
    }

    const fileContent = fs.readFileSync(fullPath, 'utf-8');

    // 当前追踪的位置
    let currentLine = Number.isFinite(line) ? line : NaN;
    let currentColumn = Number.isFinite(column) ? column : NaN;

    /**
     * 坐标规范化
     *
     * 📝 问题：用户点击可能落在行尾空白处
     * 解决：把 column 限制到本行最后一个非空白字符
     */
    const normalized = normalizeLineColumn(fileContent, currentLine, currentColumn);
    currentLine = normalized.line;
    currentColumn = normalized.column;

    // 解析 Vue SFC（单文件组件）
    const parsed = parseSfcTemplate({
      projectRoot,
      fileContent,
      filename: currentRelativePath,
    });
    if (!parsed || !parsed.descriptor || !parsed.descriptor.template) {
      return { message: '无法解析 Vue 文件模板', path: currentRelativePath };
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Phase 2: 定位模板中的目标节点
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    let targetNode = null;

    if (parsed.kind === 'vue3') {
      /**
       * Vue3 坐标转换
       *
       * Vue3 的 template AST 行号是相对于 <template> 标签内部的
       * 需要从文件行号减去 template 的起始行号
       */
      const templateStartLine = parsed.descriptor.template.loc.start.line;
      const targetLineInTemplate = currentLine - templateStartLine + 1;
      targetNode = findNodeInTemplate(parsed.templateAST, targetLineInTemplate, currentColumn);
    } else {
      /**
       * Vue2 坐标转换
       *
       * Vue2 的处理更复杂，因为 component-compiler-utils 会对模板做 de-indent
       */
      const templateLine = currentLine - parsed.templateStartLoc.line + 1;
      const columnAdjusted = Math.max(0, currentColumn - (parsed.templateBaseIndent || 0));
      const templateNormalized = normalizeLineColumn(parsed.templateSource, templateLine, columnAdjusted);

      targetNode = findNodeInTemplate(
        parsed.templateAST,
        templateNormalized.line,
        templateNormalized.column,
        null,
        parsed.templateSource
      );
    }

    // 没找到目标节点，终止追踪
    if (!targetNode) {
      return { message: '无法定位目标节点', path: currentRelativePath, line, column };
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Phase 3: 提取变量（三维度分类）
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    const categorizedVars = getCategorizedVariables(targetNode);
    const entryVars = categorizedVars.all; // 使用扁平列表，向后兼容

    /**
     * 静态内容检测
     *
     * 如果没有提取到任何变量，说明用户点击的是写死的静态文本
     * 例如：<span>Alipay</span>
     */
    if (entryVars.length === 0) {
      const staticSource = parsed.getNodeSource(targetNode);
      return this.buildStaticContentResult(currentRelativePath, targetNode.tag, staticSource);
    }

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Phase 4: 多链路追踪（核心改动）
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    /**
     * 多链路追踪架构
     *
     * 📝 设计说明：
     * 旧版只追踪一个变量，现在改为对三类变量分别追踪：
     * - content: {{ 插值 }} 中的变量
     * - attributes: :prop 绑定中的变量
     * - conditionals: v-if/v-show 中的变量
     *
     * 每类变量独立追踪，最终合并为完整的多链路结果
     */
    const rawScript = parsed.descriptor.scriptSetup?.content || parsed.descriptor.script?.content || '';

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 🆕 创建请求级 SFC 缓存
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    /**
     * SFC 缓存优化
     *
     * 📝 问题：多链路追踪时，同一个父组件可能被多个分类链路访问
     * 解决：使用请求级缓存，确保每个文件在单次请求中只解析一次
     *
     * 📊 缓存结构：Map<absolutePath, {parsed, fileContent}>
     */
    const sfcCache = new Map();

    // 缓存初始文件解析结果（避免首次迭代重复解析）
    sfcCache.set(fullPath, { parsed, fileContent });

    // 构建初始上下文，供 traceCategory 方法复用
    const initialContext = {
      relativePath: currentRelativePath,
      line: currentLine,
      column: currentColumn,
      parsed,
      targetNode,
      rawScript,
      sfcCache,  // 🆕 传递缓存
    };

    // 并行追踪三类变量
    ctx.logger.info('[多链路追踪] 开始追踪三类变量...');
    ctx.logger.info(`[分类变量] content: ${categorizedVars.content.length}, attributes: ${categorizedVars.attributes.length}, conditionals: ${categorizedVars.conditionals.length}`);

    const traceChains = {
      content: await this.traceCategory('content', categorizedVars.content, initialContext),
      attributes: await this.traceCategory('attributes', categorizedVars.attributes, initialContext),
      conditionals: await this.traceCategory('conditionals', categorizedVars.conditionals, initialContext),
    };

    ctx.logger.info('[多链路追踪] 追踪完成', {
      contentDepth: traceChains.content.length,
      attributesDepth: traceChains.attributes.length,
      conditionalsDepth: traceChains.conditionals.length,
    });

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Phase 5: 构造多链路 AI 分析输入
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    /**
     * 使用 buildMultiChainPrompt 构造 AI 输入
     *
     * 格式示例：
     * ### 📊 内容变量追踪链 (content)
     * // File: ChartCard.vue
     * // [Template] 目标 DOM 元素: <span>{{ amount }}</span>
     * ...
     *
     * ### 🎨 属性变量追踪链 (attributes)
     * // File: ChartCard.vue
     * ...
     */
    const finalCodeForAI = this.buildMultiChainPrompt(traceChains);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Phase 6: 调用 AI 分析
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    /**
     * AI 分析流程
     *
     * 把追踪到的代码片段发送给大模型，让它：
     * 1. 理解数据的完整流转路径（三条链路）
     * 2. 识别每条链路的数据源类型（API/Vuex/静态）
     * 3. 生成结构化的分析报告
     */
    const originalTargetElement = parsed.getNodeSource(targetNode) || '未知元素';

    ctx.logger.info('--- 启动 AI 智能逻辑分析（多链路模式） ---');
    ctx.logger.info(`[点击元素] ${originalTargetElement}`);

    // 调用 LLM 服务进行智能分析
    const aiAnalysis = await ctx.service.llm.analyze({
      finalCodeForAI,
      targetElement: originalTargetElement,
      traceChains,  // 传递多链路结构
    });

    // 在结果中追加点击元素信息，方便用户区分多次点击的结果
    const enrichedAnalysis = {
      ...aiAnalysis,
      clickedElement: originalTargetElement,
    };

    ctx.logger.info('--- AI 智能逻辑结果 ---');
    ctx.logger.info(`[点击元素] ${originalTargetElement}`);
    ctx.logger.info(enrichedAnalysis);

    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // Phase 7: 构造最终返回结果（多链路版本）
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    /**
     * 返回结构说明（多链路版本）
     *
     * @returns {Object} 分析结果
     * @property {string} message - 状态消息
     * @property {string} targetElement - 用户点击的 DOM 元素源码
     * @property {Object} traceChains - 三条追踪链（content/attributes/conditionals）
     * @property {Object} aiAnalysis - AI 生成的分析报告
     * @property {string} finalCodeForAI - 发送给 AI 的代码文本
     * @property {Object} categorizedVars - 分类后的变量信息
     */
    return {
      message: '分析成功',
      targetElement: originalTargetElement,
      traceChains,  // 新结构：三条独立追踪链
      aiAnalysis: enrichedAnalysis,
      finalCodeForAI,
      categorizedVars,  // 附加分类变量信息，方便前端展示
    };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 辅助方法
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * 追踪单个分类的变量链路
   *
   * 📝 核心方法：将现有的 while 循环追踪逻辑抽象为可复用的函数
   *
   * @param {string} category - 分类名称 ('content'|'attributes'|'conditionals')
   * @param {Array} categoryVars - 该分类下的变量列表
   * @param {Object} initialContext - 初始追踪上下文
   * @param {string} initialContext.relativePath - 起始文件相对路径
   * @param {number} initialContext.line - 起始行号
   * @param {number} initialContext.column - 起始列号
   * @param {Object} initialContext.targetNode - 目标 AST 节点
   * @param {Object} initialContext.parsed - 解析后的 SFC 对象
   * @param {string} initialContext.rawScript - 原始脚本内容
   * @returns {Array} 该分类的追踪链
   *
   * 📊 示例：
   *
   *   traceCategory('content', [{ variables: ['amount'] }], {...})
   *   返回：[
   *     { file: 'ChartCard.vue', tag: 'span', ... },
   *     { file: 'Dashboard.vue', tag: 'ChartCard', ... }
   *   ]
   */
  async traceCategory(category, categoryVars, initialContext) {
    const { app } = this;
    const projectRoot = app.config.projectRoot;
    const chain = [];

    // 🆕 获取请求级 SFC 缓存（跨链路复用）
    const sfcCache = initialContext.sfcCache || new Map();

    // 提取该分类下所有变量名
    const varNames = categoryVars.flatMap(item => item.variables || []);
    if (varNames.length === 0) return chain;

    // 初始化追踪状态
    let currentRelativePath = initialContext.relativePath;
    let currentLine = initialContext.line;
    let currentColumn = initialContext.column;
    let nextCallSnippet = '';
    let iteration = 0;

    // 首次迭代使用传入的上下文
    let useInitialContext = true;

    while (currentRelativePath && iteration < MAX_TRACE_DEPTH) {
      let parsed, targetNode, rawScript, fileContent;

      if (useInitialContext) {
        // 首次迭代：使用传入的已解析上下文
        parsed = initialContext.parsed;
        targetNode = initialContext.targetNode;
        rawScript = initialContext.rawScript;
        useInitialContext = false;
      } else {
        // 🆕 后续迭代：使用缓存解析（避免重复解析同一文件）
        const fullPath = path.join(projectRoot, currentRelativePath);
        if (!fs.existsSync(fullPath)) break;

        // 使用缓存获取解析结果
        const cached = this.getCachedParsedSfc(fullPath, sfcCache, {
          projectRoot,
          filename: currentRelativePath,
        });

        parsed = cached.parsed;
        fileContent = cached.fileContent;

        if (!parsed || !parsed.descriptor || !parsed.descriptor.template) break;

        // 坐标规范化
        const normalized = normalizeLineColumn(fileContent, currentLine, currentColumn);
        currentLine = normalized.line;
        currentColumn = normalized.column;

        // 定位节点
        if (parsed.kind === 'vue3') {
          const templateStartLine = parsed.descriptor.template.loc.start.line;
          const targetLineInTemplate = currentLine - templateStartLine + 1;
          targetNode = findNodeInTemplate(parsed.templateAST, targetLineInTemplate, currentColumn);
        } else {
          const templateLine = currentLine - parsed.templateStartLoc.line + 1;
          const columnAdjusted = Math.max(0, currentColumn - (parsed.templateBaseIndent || 0));
          const templateNormalized = normalizeLineColumn(parsed.templateSource, templateLine, columnAdjusted);
          targetNode = findNodeInTemplate(
            parsed.templateAST,
            templateNormalized.line,
            templateNormalized.column,
            null,
            parsed.templateSource
          );
        }

        if (!targetNode) break;

        rawScript = parsed.descriptor.scriptSetup?.content || parsed.descriptor.script?.content || '';
      }

      // 代码提纯：只保留与当前分类变量相关的代码
      const prunedScript = pruneScript(rawScript, varNames);

      // 构建当前层级信息
      const stepInfo = {
        file: currentRelativePath,
        tag: targetNode.tag,
        category,
        tracedVariables: varNames,
        prunedScript,
        source: parsed.getNodeSource(targetNode),
        callSnippet: nextCallSnippet,
      };

      nextCallSnippet = '';

      // 检查是否需要继续向上追踪（props 溯源）
      const propsVars = varNames.filter(v => isFromProps(rawScript, v));
      let shouldContinue = false;

      if (propsVars.length > 0) {
        const primaryVar = propsVars[0];
        const parents = webpackService.getParents(currentRelativePath);

        if (parents.length > 0) {
          const parentRelativePath = parents[0];
          const parentFullPath = path.resolve(projectRoot, parentRelativePath);
          const childClassName = path.basename(currentRelativePath, '.vue');
          // 🆕 传递 sfcCache 给 findBindingInParent，避免重复解析父组件
          const binding = findBindingInParent(parentFullPath, childClassName, primaryVar, sfcCache);

          if (binding) {
            nextCallSnippet = binding.rawTag;
            currentRelativePath = parentRelativePath;
            currentLine = binding.line;
            currentColumn = binding.column;
            shouldContinue = true;

            // 更新要追踪的变量为父组件中的绑定变量
            varNames.length = 0;
            varNames.push(binding.variable);
          }
        }
      }

      chain.push(stepInfo);

      // Vuex 检测（仅对当前分类变量）
      const vuexMapping = findVuexDefinition(prunedScript, varNames);
      if (vuexMapping) {
        const storeSource = getVuexSource(projectRoot, vuexMapping);
        if (storeSource) {
          const vuexTraceInfo = this.buildVuexTraceInfo(vuexMapping, storeSource, projectRoot);
          vuexTraceInfo.category = category;
          chain.push(vuexTraceInfo);
          break;
        }
      }

      if (!shouldContinue) break;
      iteration++;
    }

    return chain;
  }

  /**
   * 构造多链路 AI 提示词
   *
   * 📝 将三条追踪链格式化为 AI 可理解的文本
   *
   * @param {Object} traceChains - 多链路追踪结果
   * @param {Array} traceChains.content - 内容变量追踪链
   * @param {Array} traceChains.attributes - 属性变量追踪链
   * @param {Array} traceChains.conditionals - 条件变量追踪链
   * @returns {string} 格式化后的 AI 输入文本
   */
  buildMultiChainPrompt(traceChains) {
    let output = '';

    for (const category of CATEGORY_TYPES) {
      const chain = traceChains[category];
      if (!chain || chain.length === 0) continue;

      output += `\n### ${CATEGORY_LABELS[category]}\n`;
      output += this.formatChainForAI(chain);
      output += '\n';
    }

    return output || '// 未追踪到任何变量链路';
  }

  /**
   * 格式化单条追踪链为 AI 可读文本
   *
   * @param {Array} chain - 追踪链
   * @returns {string} 格式化文本
   */
  formatChainForAI(chain) {
    // 反转链路：从数据源到 UI
    const reversed = [...chain].reverse();

    return reversed.map(step => {
      let output = `// File: ${step.file}\n`;

      if (step.source) {
        output += `// [Template] 目标 DOM 元素:\n${step.source}\n\n`;
      }

      if (step.callSnippet) {
        output += `// [Data Flow] 模板中调用子组件的代码:\n${step.callSnippet}\n\n`;
      }

      if (step.tracedVariables && step.tracedVariables.length > 0) {
        output += `// [Traced Variables] ${step.tracedVariables.join(', ')}\n`;
      }

      output += `// [Logic] 关联的脚本逻辑:\n${step.prunedScript || '// (该层级无相关脚本逻辑)'}`;

      return output;
    }).join('\n\n' + '-'.repeat(40) + '\n\n');
  }

  /**
   * 构建静态内容结果
   *
   * 📝 使用场景：用户点击的是写死的静态文本，如 <span>Alipay</span>
   *
   * @param {string} file - 文件路径
   * @param {string} tag - 标签名
   * @param {string} source - 元素源码
   * @returns {Object} 静态内容分析结果
   *
   * 📊 示例：
   *
   *   用户点击：<span>Alipay</span>
   *
   *   返回：
   *   {
   *     message: '静态内容',
   *     targetElement: '<span>Alipay</span>',
   *     traceChain: [{...}],
   *     aiAnalysis: {
   *       dataSource: { type: 'static', description: '写死的静态文本' }
   *     }
   *   }
   */
  buildStaticContentResult(file, tag, source) {
    return {
      message: '静态内容',
      targetElement: source,
      traceChain: [{
        file,
        tag,
        source,
        prunedScript: '',
        callSnippet: '',
      }],
      aiAnalysis: {
        fullLinkTrace: '该元素为静态内容，无需追踪数据来源',
        dataSource: {
          type: 'static',
          description: '写死的静态文本，不涉及动态数据',
        },
        componentAnalysis: [{
          file,
          role: '展示静态内容',
          dataFlow: '无数据流转',
        }],
      },
      finalCodeForAI: '',
    };
  }

  /**
   * 构建 Vuex 追踪信息
   *
   * 📝 使用场景：变量来自 Vuex 的 mapState/mapGetters
   *
   * @param {Object} vuexMapping - Vuex 映射信息
   * @param {string} vuexMapping.namespace - 模块命名空间（如 'user'）
   * @param {string} vuexMapping.type - 映射类型（'state' 或 'getter'）
   * @param {string} vuexMapping.key - 映射的键名
   * @param {string} storeSource - Store 模块的源码
   * @param {string} projectRoot - 项目根目录
   * @returns {Object} Vuex 追踪层级信息
   *
   * 📊 示例：
   *
   *   组件中：...mapState('user', ['userInfo'])
   *
   *   返回：
   *   {
   *     file: 'src/store/modules/user.js',
   *     tag: 'VuexStore',
   *     source: 'state: { userInfo: null }',
   *     prunedScript: '完整的 store 相关代码',
   *     callSnippet: '',
   *     isVuex: true,
   *     vuexInfo: { namespace: 'user', type: 'state', key: 'userInfo' }
   *   }
   */
  buildVuexTraceInfo(vuexMapping, storeSource, projectRoot) {
    const { namespace, type, key } = vuexMapping;

    // 构建 Store 文件路径
    const storeFile = namespace
      ? `src/store/modules/${namespace}.js`
      : 'src/store/index.js';

    // 查找可能修改这个 state 的 mutations
    const mutationTriggers = findMutationTriggers(projectRoot, namespace, key);

    return {
      file: storeFile,
      tag: 'VuexStore',
      source: storeSource,
      prunedScript: storeSource,
      callSnippet: '',
      isVuex: true,
      vuexInfo: {
        namespace,
        type,
        key,
        mutationTriggers,  // 哪些地方触发了 mutation
      },
    };
  }
}

module.exports = TraceService;

