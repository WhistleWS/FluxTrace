# AI Trace：全链路数据流转分析系统

AI Trace 是一款为解决大型 Vue 项目中“从 UI 元素到后端字段”溯源难题而研发的智能工具。它通过 Webpack 依赖分析、AST 源码提纯与 LLM 智能逻辑分析，实现了代码级的数据全链路追踪。

---

## 🚀 核心价值

*   **极速定位**：从 UI 点击直接映射到源码行号，省去繁琐的全局搜索。
*   **全链路追踪**：从子组件 Props 追溯到父组件 Data，再到 Vuex Store，最终定位到 API 接口。
*   **Token 优化**：基于 AST 的两次源码提纯，将冗长的业务代码缩减 90%，大幅提升 LLM 分析精度并降低成本。
*   **智能识别**：利用七层结构化 Prompt 驱动 LLM，识别复杂的业务逻辑、动态数据加工及接口依赖。

---

## 🏗️ 核心架构

| 层级 | 核心技术 | 功能目标 | 效能指标 |
| :--- | :--- | :--- | :--- |
| **精准定位层** | Webpack 依赖图 | 缩小分析范围至目标链路文件 | 99% (240w+ -> 2w+ 行) |
| **源码提纯层** | AST (Babel) | 提取关键源码片段，最大化 Token 利用率 | 90% (2w+ -> 2k+ 行) |
| **智能分析层** | LLM (Prompt) | 识别业务逻辑、数据流转、接口依赖 | 准确率 98% |
| **全链路数据层** | 数据映射 | 前后端链路打通，字段级精准溯源 | 端到端视图 |

---

## 🛠️ 技术栈

*   **框架**：[Egg.js](https://eggjs.org/) (高效、规范的 Node.js 企业级框架)
*   **AST 解析**：`@babel/parser`、`@babel/traverse`、`@vue/compiler-sfc`
*   **依赖溯源**：Webpack Compilation API & Stats Analysis
*   **大模型能力**：LangChain + OpenAI / 兼容模型
*   **可靠性控制**：内置限流、超时、指数退避重试及降级熔断机制

---

## 📂 项目结构

```text
ai-trace/
├── app/
│   ├── controller/      # 控制层：处理 API 请求
│   ├── router.js        # 路由定义
│   ├── service/         # 服务层：Trace 核心追踪逻辑 & LLM 对接
│   └── lib/             # 核心库：AST 处理、Webpack 解析、Prompt 组装
│       ├── utils/       # 基础工具：缓存管理、路径解析、Webpack 编译器
│       ├── scriptAST.js # 脚本提纯逻辑
│       ├── templateAST.js # 模板定位与提纯
│       └── WebpackService.js # 依赖图构建与反向查询
├── config/              # Egg.js 配置文件
├── stats.json           # Webpack 依赖数据（由项目打包生成）
└── .env                 # 环境变量（API_KEY, BASE_URL 等）
```

---

## ⚙️ 工作原理

### 1. 精准定位层（DOM -> Source）
通过解析 Vue SFC 模板 AST，结合前端传入的行号、列号，精准定位目标 DOM 节点。随后提取出该节点关联的所有变量标识符。

### 2. 源码提纯层（AST Pruning）
*   **Template 提纯**：仅保留目标节点及其父路径节点，剔除无关 HTML。
*   **Script 提纯**：以目标变量为起点，递归收集依赖关系（如：Data -> Computed -> Method -> Constant）。仅保留相关的声明周期和 `import` 语句，大幅减少 LLM 处理的 Token 数量。

### 3. 智能分析层（7-Layer Prompt）
采用结构化 Prompt 架构：
1. **角色定义**：定义为资深前端架构师。
2. **任务描述**：明确分析变量流向的目标。
3. **分析维度**：涵盖 Vue 组件、Vuex、API 接口等。
4. **输出格式**：强制 JSON 输出，包含数据源类型、路径明细等。
5. **提纯代码**：插入经过 AST 缩减过的跨文件源码。
6. **接口线索**：提供额外提取的 API 路径信息。
7. **解析自修复**：内置 JSON 结构校验与自动修复机制。

---

## 🚀 快速上手

### 1. 安装依赖
```bash
cd ai-trace
npm install
```

### 2. 配置环境
创建 `.env` 文件并配置：
```env
AI_API_KEY=your_key
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL_NAME=gpt-4o
# 可选：可靠性配置
LLM_TIMEOUT_MS=30000
LLM_MAX_RETRIES=2
```

### 3. 生成依赖数据
在你的 Vue 业务项目中运行（需安装并配置 Webpack）：
```bash
npx webpack --profile --json > ai-trace/stats.json
```
*注：AI-Trace 会使用 Git Commit Hash 自动缓存依赖图，仅在代码变动时重新解析。*

### 4. 启动服务
```bash
npm run dev
```
服务启动于 `http://localhost:3000`。

---

## 📡 接口文档

### POST /api/analyze

**请求负载：**
```json
{
  "path": "src/pages/dashboard/WorkPlace.vue",
  "line": 150,
  "column": 12
}
```

**成功响应 (摘要)：**
```json
{
  "targetElement": "<span>{{ amount }}</span>",
  "traceChain": [...], // 跨文件的源码链路明细
  "aiAnalysis": {
    "fullLinkTrace": "数据从 /api/v1/orders 接口获取，经过 handleData 格式化后通过 props 传入...",
    "dataSource": {
      "type": "API",
      "endpoint": "/api/v1/orders",
      "method": "GET"
    },
    "componentAnalysis": [...]
  }
}
```

---

## 🛡️ 可靠性保障

*   **并发控制**：防止短时间大量点击导致 LLM 请求堆积。
*   **熔断降级**：当模型服务持续响应异常时，自动进入熔断状态，返回业务级降级结果，确保前端不挂起。
*   **原子化自修复**：针对 LLM 偶发的非法 JSON 输出，系统会自动发起二次修复请求。

---

## 📝 开源协议

MIT
