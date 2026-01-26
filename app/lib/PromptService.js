require('dotenv').config(); // 必须在最顶部调用

const { ChatOpenAI } = require("@langchain/openai");
const { PromptTemplate } = require("@langchain/core/prompts");
const { StructuredOutputParser } = require("@langchain/core/output_parsers");
const { z } = require("zod");
const { extractApiEvidence } = require("./apiExtractor");

/**
 * 兼容 LangChain 的不同输出形态：
 * - 有的模型返回 string
 * - 有的返回 { content: string }
 * 统一转为纯文本，方便后续做 JSON 解析与修复。
 */
function toText(output) {
  if (typeof output === 'string') return output;
  if (output && typeof output.content === 'string') return output.content;
  return String(output || '');
}

/**
 * 模型偶尔会用 ```json ... ``` 包裹输出，导致结构化解析失败。
 * 这里把 code fence 去掉，保证传给 parser 的是纯 JSON 文本。
 */
function stripCodeFences(text) {
  if (!text) return text;
  return String(text)
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

/**
 * AI 分析服务：实现七层 Prompt 架构
 *
 * 本次改动要点（对应架构文档的"智能分析层/接口信息层"）：
 * 1) 第六层 api_info 不再是单一正则字符串，而是来自 apiExtractor 的结构化证据列表（最多 30 条）
 * 2) 输出 schema 收紧（type/method 枚举、endpoint 可为空）提升一致性
 * 3) 增加"解析失败自修复"：第一次解析失败时，触发第二次 prompt 只做 JSON 修复，不允许新增事实
 * 4) 支持多链路追踪输入（content/attributes/conditionals）
 */
async function runAIAnalysis(finalCodeForAI, targetElement, traceChains) {

  // 1. 初始化模型
  const model = new ChatOpenAI({
    apiKey: process.env.AI_API_KEY,
    configuration: {
      baseURL: process.env.AI_BASE_URL,
    },
    modelName: process.env.AI_MODEL_NAME,
    temperature: 0, // 设为 0 以保证分析逻辑的严谨性
  });

  /**
   * 第六层：接口信息提取（证据驱动）
   * - 提取结果会直接喂给模型，要求模型"有证据才下结论"，降低胡编 endpoint/method 的概率。
   * - 多链路模式：合并三条链路中的所有步骤用于 API 证据提取
   */
  // 合并多链路为扁平数组，供 apiExtractor 使用
  const allChainSteps = [
    ...(traceChains?.content || []),
    ...(traceChains?.attributes || []),
    ...(traceChains?.conditionals || []),
  ];
  const apiEvidence = extractApiEvidence({ traceChain: allChainSteps });
  const extractedAPIs =
    apiEvidence.length > 0
      ? JSON.stringify(apiEvidence.slice(0, 30), null, 2)
      : '未在链路代码中提取到明确的接口调用证据。';
  // 2. 定义第四层：输出格式 (基于架构文档要求 - 三维度变量分析)
  const DataSourceType = z.enum(['API', 'Store', 'Static', 'UNKNOWN']);
  const HttpMethod = z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'UNKNOWN']);

  const parser = StructuredOutputParser.fromZodSchema(
    z.object({
      fullLinkTrace: z.string().describe("用自然语言描述数据从源头到 UI 的完整流转路径，像工程师解释代码一样"),
      dataSource: z.object({
        type: DataSourceType.describe("API / Store / Static / UNKNOWN"),
        endpoint: z.string().nullable().describe("识别出的接口路径；无法确定时为 null"),
        method: HttpMethod.describe("接口请求方法；无法确定时为 UNKNOWN")
      }),
      componentAnalysis: z.array(z.object({
        file: z.string(),
        role: z.string().describe("该组件在链路中的作用，如：容器组件/展示组件"),
        dataMapping: z.string().describe("该层发生的变量映射关系，如：res.data -> this.list")
      })),
      // === 三维度变量分析（核心新增） ===
      variableAnalysis: z.object({
        // 内容变量：{{ }} 插值中的变量
        content: z.array(z.object({
          name: z.string().describe("变量名"),
          apiDependency: z.string().nullable().describe("接口字段依赖路径，如 res.data.user.name；无 API 依赖时为 null"),
          computeLogic: z.string().describe("取值逻辑描述，如：通过 computed 计算、直接赋值、filter 过滤等"),
          dataChain: z.string().describe("数据链路，如：API -> Store -> Computed -> Template")
        })),
        // 属性变量：:prop、v-model、@event 中的变量
        attributes: z.array(z.object({
          name: z.string().describe("属性/变量名"),
          directive: z.string().describe("指令类型，如 :class, :disabled, v-model, @click"),
          definition: z.string().describe("定义位置：props / data / computed / methods / store"),
          source: z.string().describe("数据来源描述")
        })),
        // 条件变量：v-if、v-show 中的变量
        conditionals: z.array(z.object({
          expression: z.string().describe("完整条件表达式，如 isLogin && hasRole === 'admin'"),
          dependencies: z.array(z.string()).describe("依赖的变量列表"),
          dataChain: z.string().describe("条件变量的数据链路"),
          description: z.string().describe("条件控制逻辑的自然语言描述，如：当用户已登录且为管理员时显示")
        }))
      }),
      // === 保留字段 ===
      confidence: z.number().min(0).max(100).describe("分析置信度 0-100，低于 60 表示信息不足需人工复查"),
      suggestNextStep: z.string().nullable().describe("建议的下一步操作，如：'查看 Vuex store/account 模块定义' 或 null"),
    })
  );

  const formatInstructions = parser.getFormatInstructions();

  // 3. 组装七层 Prompt 模板（含 Few-Shot 示例）
  const template = `
# 第一层：角色定义层
你是一个资深 Vue 响应式变量数据链路分析专家，擅长从代码中精准还原业务逻辑，并用简洁易懂的方式解释给开发者。

# 第二层：任务描述层
用户在 Vue 项目中点击了以下 DOM 元素：
\`\`\`html
{targetElement}
\`\`\`

# 第三层：分析要求层
请基于提供的代码片段，回答以下问题：
1. **数据来源**：这个 DOM 元素显示的数据从哪里来？（API / Vuex Store / 静态数据）
2. **数据流转**：数据是如何从源头流转到这个 DOM 的？经过了哪些变量？
3. **关键代码**：哪些代码片段决定了这个 DOM 的渲染内容？
4. **三维度变量分析**（核心要求）：
   - **内容变量(content)**：分析 {{ }} 插值中的变量，追踪其 API 依赖、取值逻辑、完整数据链路
   - **属性变量(attributes)**：分析 :prop、v-model、@event 中的变量，说明定义位置和数据来源
   - **条件变量(conditionals)**：分析 v-if、v-show 中的条件表达式，列出依赖变量和控制逻辑

**注意事项**：
- 只描述有价值的信息，不要说"链路深度为X层"这种废话
- 如果是单组件内的数据流，直接说明数据来源和使用方式即可
- 如果涉及跨组件传递，才需要说明组件间的 props 传递关系
- 用自然语言描述，像资深工程师给同事解释代码一样
- 只有在第六层 api_info 中存在真实 URL 证据时，才能确定是 API 数据源
- confidence 字段：有明确 API/Store 证据时给 80-100，仅靠推测时给 40-60
- variableAnalysis 的三个维度必须完整填写，即使某个维度为空数组也要保留

# 第四层：输出格式层
必须严格按照以下 JSON 格式返回：
{format_instructions}

# 第4.5层：Few-Shot 示例 [重要参考]
**示例1：API 数据源（高置信度）**
点击元素：\`<span>{{{{ userName }}}}</span>\`
输出：
\`\`\`json
{{
  "fullLinkTrace": "userName 来自 GET /api/user 接口。在 created 钩子中调用 request('/api/user')，响应 res.data.name 赋值给 this.userName，模板通过插值渲染。",
  "dataSource": {{"type": "API", "endpoint": "/api/user", "method": "GET"}},
  "componentAnalysis": [{{"file": "User.vue", "role": "数据获取组件", "dataMapping": "res.data.name -> this.userName -> 模板渲染"}}],
  "variableAnalysis": {{
    "content": [
      {{"name": "userName", "apiDependency": "res.data.name", "computeLogic": "API 响应直接赋值给 data 属性", "dataChain": "API(/api/user) -> this.userName -> Template"}}
    ],
    "attributes": [],
    "conditionals": []
  }},
  "confidence": 95,
  "suggestNextStep": null
}}
\`\`\`

**示例2：Vuex Store 数据源**
点击元素：\`<span v-if="isLogin">{{{{ lang }}}}</span>\`
输出：
\`\`\`json
{{
  "fullLinkTrace": "lang 变量通过 mapState 从 Vuex 的 setting 模块映射而来，用于控制多语言显示。isLogin 控制元素是否显示。",
  "dataSource": {{"type": "Store", "endpoint": null, "method": "UNKNOWN"}},
  "componentAnalysis": [{{"file": "Header.vue", "role": "展示组件", "dataMapping": "store.setting.lang -> computed.lang"}}],
  "variableAnalysis": {{
    "content": [
      {{"name": "lang", "apiDependency": null, "computeLogic": "通过 mapState 从 Vuex store 映射", "dataChain": "Store(setting.lang) -> Computed(lang) -> Template"}}
    ],
    "attributes": [],
    "conditionals": [
      {{"expression": "isLogin", "dependencies": ["isLogin"], "dataChain": "Store(user.isLogin) -> Computed -> Template", "description": "当用户已登录时显示该元素"}}
    ]
  }},
  "confidence": 90,
  "suggestNextStep": "查看 src/store/modules/setting.js 中 lang 的初始化和修改逻辑"
}}
\`\`\`

**示例3：跨组件 Props 传递**
点击元素：\`<Button :loading="submitting" @click="handleSubmit">{{{{ buttonText }}}}</Button>\`
输出：
\`\`\`json
{{
  "fullLinkTrace": "buttonText 是从父组件通过 props 传入。submitting 控制按钮加载状态，handleSubmit 是点击事件处理函数。",
  "dataSource": {{"type": "API", "endpoint": "/api/page", "method": "GET"}},
  "componentAnalysis": [
    {{"file": "SubmitButton.vue", "role": "展示组件", "dataMapping": "props.buttonText -> 模板渲染"}},
    {{"file": "FormPage.vue", "role": "容器组件", "dataMapping": "res.data.submitLabel -> buttonText -> :text"}}
  ],
  "variableAnalysis": {{
    "content": [
      {{"name": "buttonText", "apiDependency": "res.data.submitLabel", "computeLogic": "父组件通过 props 传入，源自 API 响应", "dataChain": "API -> Parent(FormPage) -> Props -> Template"}}
    ],
    "attributes": [
      {{"name": "submitting", "directive": ":loading", "definition": "data", "source": "组件内 data 属性，在 handleSubmit 方法中控制"}},
      {{"name": "handleSubmit", "directive": "@click", "definition": "methods", "source": "组件内 methods 定义的提交处理函数"}}
    ],
    "conditionals": []
  }},
  "confidence": 85,
  "suggestNextStep": null
}}
\`\`\`

**示例4：复杂三维度变量（完整示例）**
点击元素：\`<div v-if="isVisible && hasPermission" :class="containerClass">{{{{ formatAmount(amount) }}}}</div>\`
输出：
\`\`\`json
{{
  "fullLinkTrace": "amount 来自 API 接口，通过 formatAmount 方法格式化后显示。containerClass 是计算属性控制样式。元素仅在 isVisible 且 hasPermission 时显示。",
  "dataSource": {{"type": "API", "endpoint": "/api/dashboard", "method": "GET"}},
  "componentAnalysis": [{{"file": "Dashboard.vue", "role": "数据展示组件", "dataMapping": "res.data.amount -> this.amount -> formatAmount() -> 模板渲染"}}],
  "variableAnalysis": {{
    "content": [
      {{"name": "amount", "apiDependency": "res.data.amount", "computeLogic": "API 响应赋值后，通过 formatAmount 方法格式化", "dataChain": "API(/api/dashboard) -> this.amount -> formatAmount() -> Template"}},
      {{"name": "formatAmount", "apiDependency": null, "computeLogic": "methods 中定义的格式化函数", "dataChain": "Methods -> Template"}}
    ],
    "attributes": [
      {{"name": "containerClass", "directive": ":class", "definition": "computed", "source": "计算属性，根据当前状态动态返回 class 名"}}
    ],
    "conditionals": [
      {{"expression": "isVisible && hasPermission", "dependencies": ["isVisible", "hasPermission"], "dataChain": "isVisible: data 属性; hasPermission: Store(user.permissions) -> Computed", "description": "当元素可见且用户有权限时显示"}}
    ]
  }},
  "confidence": 88,
  "suggestNextStep": "查看 formatAmount 方法的具体格式化逻辑"
}}
\`\`\`

# 第五层：源代码层 [核心]
以下是按溯源顺序排列的代码片段：
---
{code}
---

# 第六层：接口信息层
提取到的接口调用证据：
{api_info}

# 第七层：最终提醒层
1. 必须返回纯 JSON 格式，不要 Markdown 代码块
2. fullLinkTrace 要像人话一样自然，参考示例的风格
3. confidence：有明确证据 80+，推测性结论 40-60，完全猜测 <40
4. suggestNextStep：当数据来自 Store 或需要进一步追踪时给出建议，否则为 null
`;

  const prompt = new PromptTemplate({
    template,
    inputVariables: ["targetElement", "code", "api_info"],
    partialVariables: { format_instructions: formatInstructions },
  });

  try {
    const input = {
      targetElement: targetElement,
      code: finalCodeForAI,
      api_info: extractedAPIs,
    };

    /**
     * 第一阶段：正常分析
     * - 不直接用 pipe(parser) 的原因：我们需要拿到“原始输出”用于第二阶段修复
     */
    const promptText = await prompt.format(input);
    const raw = await model.invoke(promptText);
    const rawText = stripCodeFences(toText(raw));

    try {
      return await parser.parse(rawText);
    } catch (parseError) {
      /**
       * 第二阶段：结构化输出自修复
       * - 只允许修 JSON 格式/字段缺失等问题，不允许引入新事实
       * - 目标：把失败率从“遇到非 JSON 就 500/报错”降到“自动修复后可用”
       */
      const repairTemplate = `
你是一个严格的 JSON 修复器。你的任务：把用户提供的输出修复为严格匹配指定 JSON schema 的结果。

要求：
1. 只能修复格式问题（补齐引号、去掉多余文本、补齐字段等），不要添加任何新事实。
2. 只输出纯 JSON，不要输出任何解释、不要输出 Markdown 代码块。
3. 必须符合 schema。

schema：
{format_instructions}

待修复输出：
{bad_output}
`;

      const repairPrompt = new PromptTemplate({
        template: repairTemplate,
        inputVariables: ['bad_output'],
        partialVariables: { format_instructions: formatInstructions },
      });

      const repairedText = await repairPrompt.format({ bad_output: rawText });
      const repaired = await model.invoke(repairedText);
      const repairedRaw = stripCodeFences(toText(repaired));
      return await parser.parse(repairedRaw);
    }
  } catch (error) {
    // --- 增加以下详细日志 ---
    console.error("❌ AI 报错详情:", error);

    // 如果是解析错误，打印 AI 到底返回了什么烂摊子
    if (error.output) {
      console.log("📄 AI 原始输出内容:", error.output);
    }
    // -----------------------
    console.error("AI Analysis Error:", error);
    return { error: "AI 分析逻辑超时或格式解析失败" };
  }
}
module.exports = { runAIAnalysis };
