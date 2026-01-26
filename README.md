# FluxTrace：全链路数据流转分析系统

FluxTrace 是一款为解决大型 Vue 项目中“从 UI 元素到后端字段”溯源难题而研发的智能工具。它通过 Webpack 依赖分析、AST 源码提纯与 LLM 智能逻辑分析，实现了代码级的数据全链路追踪。

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
| **精准定位层** | Webpack 依赖图 | 缩小分析范围至目标链路文件 | 99% (200w+ -> 2w+ 行) |
| **源码提纯层** | AST (Babel) | 提取关键源码片段，最大化 Token 利用率 | 90% (2w+ -> 2k+ 行) |
| **智能分析层** | LLM (Prompt) | 识别业务逻辑、数据流转、接口依赖 | 7 层结构化 Prompt |
| **全链路数据层** | 数据映射 | 前后端链路打通，字段级精准溯源 | 端到端视图 |
| **性能优化层** | 请求级缓存 | 多链路追踪共享 SFC 解析结果 | 77% ↓ (13→3 次解析) |

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
FluxTrace/
├── app/
│   ├── controller/      # 控制层：处理 API 请求
│   ├── router.js        # 路由定义
│   ├── service/         # 服务层：Trace 核心追踪逻辑 & LLM 对接
│   └── lib/             # 核心库：AST 处理、Webpack 解析、Prompt 组装
├── client/              # 前端 SDK：支持一键接入 Vue 项目
├── plugins/             # 编译器插件：提供 Webpack 插件支持
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
cd FluxTrace
npm install
```

### 2. 配置环境
创建 `.env` 文件并配置：
```env
AI_API_KEY=your_key
AI_BASE_URL=https://api.openai.com/v1
AI_MODEL_NAME=gpt-4o
```

### 3. 后端启动
```bash
npm run dev
```
服务启动于 `http://localhost:3000`。

---

## 📡 客户端接入

### 方式 A：使用自动注入插件 (推荐)
在 `vue.config.js` 中配置：
```javascript
const { createFluxTracePlugins } = require('./FluxTrace/plugins/webpack');

module.exports = {
  configureWebpack: {
    plugins: [
      ...createFluxTracePlugins({ port: 3000 })
    ]
  }
}
```

### 方式 B：手动集成 SDK
在项目入口文件 (`main.ts` 或 `main.js`) 中：
```typescript
import { initFluxTrace } from '../FluxTrace/client';

initFluxTrace({
  baseUrl: 'http://localhost:3000'
});
```

---

## 📝 开源协议

MIT
