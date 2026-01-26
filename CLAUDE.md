# CLAUDE.md

本文件为 Claude Code (claude.ai/code) 在此代码库中工作时提供指导。

## 项目概述

FluxTrace 是一个 Vue 应用数据流追踪工具，能够从 UI 元素反向追踪到数据源头（API、Store 或静态数据），并通过大模型生成结构化分析报告。

**技术栈：**
- Egg.js 3.x（Node.js 框架）
- @vue/compiler-sfc + @vue/compiler-core（Vue SFC 解析）
- @babel/parser + @babel/traverse + @babel/generator（JavaScript AST 分析）
- LangChain + OpenAI 兼容 API（大模型调用）
- Webpack stats.json（组件依赖图）

## 开发命令

```bash
# 安装依赖
npm install

# 启动开发服务器（端口 3000，支持热重载）
npm run dev

# 生产环境启动
npm run start

# 停止生产服务
npm run stop
```

## 架构概述

### 目录结构

```
FluxTrace/
├── app.js              # Egg 应用启动钩子，初始化 WebpackService
├── client/             # 前端 SDK（独立模块）
│   ├── index.js        # SDK 入口，提供 initFluxTrace() 和 analyze()
│   ├── index.d.ts      # TypeScript 类型声明
│   ├── package.json    # npm 包配置
│   └── README.md       # SDK 使用说明
├── plugins/            # 构建工具插件
│   └── webpack.js      # Webpack 插件，自动注入监听脚本
├── app/
│   ├── router.js       # 路由定义（/api/analyze）
│   ├── controller/
│   │   └── analyze.js  # HTTP 层，参数获取和响应处理
│   ├── service/
│   │   ├── trace.js    # 核心追踪业务逻辑
│   │   └── llm.js      # 大模型调用服务
│   └── lib/
│       ├── templateAST.js    # 模板 AST 分析
│       ├── scriptAST.js      # 脚本 AST 分析与代码提纯
│       ├── variableAST.js    # 变量提取与溯源
│       ├── WebpackService.js # Webpack 依赖图解析
│       ├── PromptService.js  # AI 提示词构造
│       ├── apiExtractor.js   # API 接口信息提取
│       ├── sfcTemplate.js    # SFC 模板处理
│       └── utils/
│           ├── traceUtils.js # 追踪工具函数
│           ├── astUtils.js   # AST 工具函数
│           ├── astConfig.js  # Babel 解析配置
│           ├── pathUtils.js  # 路径处理工具
│           └── cacheManager.js # 缓存管理
├── config/
│   └── config.default.js # Egg 默认配置
└── test/               # 测试文件
```

### 核心工作流程

1. **请求接收** - `/api/analyze` 接收文件路径、行号、列号
2. **模板定位** - `templateAST.js` 根据坐标定位目标 DOM 元素
3. **变量提取** - `variableAST.js` 从元素属性和插值中提取变量（分三类：content/attributes/conditionals）
4. **多链路追踪** - 对每类变量独立追踪，共享 SFC 缓存避免重复解析
5. **脚本提纯** - `scriptAST.js` 只保留与目标变量相关的代码
6. **组件溯源** - 若变量来自 props，通过 `WebpackService` 查找父组件
7. **递归追踪** - 在父组件中继续追踪，直到找到数据源
8. **AI 分析** - `PromptService.js` 构造提示词，调用大模型生成报告

### 多链路追踪架构

变量按来源分为三类，各自独立追踪：

| 类别 | 说明 | 示例 |
|------|------|------|
| `content` | 文本插值变量 | `{{ amount }}` |
| `attributes` | 动态属性绑定 | `:class="containerClass"` |
| `conditionals` | 条件渲染变量 | `v-if="isVisible"` |

```javascript
// 三条追踪链独立运行，共享 sfcCache
const traceChains = {
  content: await this.traceCategory('content', contentVars, { sfcCache }),
  attributes: await this.traceCategory('attributes', attrVars, { sfcCache }),
  conditionals: await this.traceCategory('conditionals', condVars, { sfcCache }),
};
```

### 请求级 SFC 缓存

为避免多链路追踪时重复解析同一文件，采用请求级缓存：

```javascript
// 缓存结构：Map<absolutePath, { parsed, fileContent }>
const sfcCache = new Map();

// 优化效果示例（3变量 × 3层深度）：
// 优化前：13 次解析
// 优化后：3 次解析（仅首次 MISS）
```

### 关键模块说明

| 模块 | 功能 |
|------|------|
| `templateAST.js` | `findNodeInTemplate()` - 根据行列号定位模板元素 |
| `scriptAST.js` | `pruneScript()` - 代码提纯，剔除无关逻辑 |
| `variableAST.js` | `getUniversalVariables()` - 提取并溯源变量（支持 Vue2/Vue3） |
| `sfcTemplate.js` | `parseSfcTemplate()` - SFC 解析，自动选择 Vue2/Vue3 编译器 |
| `WebpackService.js` | 解析 stats.json 构建依赖图，查找父组件 |
| `traceUtils.js` | `isFromProps()` / `findBindingInParent()` - 组件间追踪（支持缓存） |
| `PromptService.js` | `runAIAnalysis()` - 构造提示词并调用大模型 |

### Vue2 兼容性处理

Vue2 的 `vue-template-compiler` 在处理动态属性时，会将 `:class`、`:style` 等绑定从 `attrsList` 移至 `rawAttrsMap`。变量提取时优先读取 `rawAttrsMap`：

```javascript
// variableAST.js 中的兼容处理
let attrsToProcess = [];
if (node.rawAttrsMap && Object.keys(node.rawAttrsMap).length > 0) {
    attrsToProcess = Object.values(node.rawAttrsMap);
} else if (node.attrsList && node.attrsList.length > 0) {
    attrsToProcess = node.attrsList;
}
```

### 节点源码截断

对于带 `v-for` 的大型容器元素，`getNodeSource()` 会自动截断，避免 AI Token 溢出：

- **最大长度**：500 字符
- **最大行数**：10 行
- **截断策略**：仅保留开标签，添加省略注释

### 代码提纯规则

`pruneScript()` 函数对脚本代码进行精简：
- 保留与目标变量直接相关的代码
- 剔除 `components`、`i18n`、`directives` 等非业务逻辑
- 只保留包含业务变量的 `props`、`computed`、`methods`
- 过滤不相关的生命周期钩子

## API 接口

### GET/POST /api/analyze

**请求参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| path | string | 是 | Vue 组件文件相对路径 |
| line | number | 是 | 目标元素所在行号 |
| column | number | 是 | 目标元素所在列号 |

**响应结构：**
```json
{
  "message": "分析成功",
  "targetElement": "<div>{{ amount }}</div>",
  "traceChain": [...],
  "aiAnalysis": {
    "fullLinkTrace": "数据流转描述",
    "dataSource": { "type": "API", "endpoint": "/api/xxx" },
    "componentAnalysis": [...]
  }
}
```

## 环境变量

在 `.env` 文件中配置：

```bash
AI_API_KEY=your-api-key        # 大模型 API Key
AI_BASE_URL=https://api.xxx    # 大模型 API 地址
AI_MODEL_NAME=model-name       # 模型名称
```

可选：
- `PORT` - 服务端口（默认 3000）
- `PROJECT_ROOT` - 项目根目录（默认为 FluxTrace 上级目录）

## 前置依赖

需要在被分析的 Vue 项目根目录生成 `stats.json`：

```bash
# 在 vue-antd-admin 根目录执行
ANALYZE=true yarn build
# 或
npx webpack --profile --json > stats.json
```

## 与前端集成

FluxTrace 提供两种集成方式：

### 方式 A：SDK 引入（推荐）

在项目入口文件中初始化：

```typescript
// src/main.ts
import { initFluxTrace } from '../FluxTrace/client';

initFluxTrace({
  baseUrl: 'http://localhost:3000',  // 可选，后端地址
  onlyDev: true,                      // 可选，默认仅开发环境
  silent: false,                      // 可选，是否静默模式
  onSuccess: (result) => {},          // 可选，成功回调
  onError: (error) => {}              // 可选，失败回调
});
```

### 方式 B：Webpack 插件（零配置）

在 `vue.config.js` 中配置：

```javascript
const { createFluxTracePlugins } = require('./FluxTrace/plugins/webpack');

module.exports = {
  configureWebpack: {
    plugins: [...createFluxTracePlugins({ port: 3000 })]
  }
};
```

### 前置条件

需要在宿主项目安装 `code-inspector-plugin`：

```bash
npm install code-inspector-plugin -D
```

## 关键文件

| 文件 | 说明 |
|------|------|
| `app.js` | 应用启动钩子，初始化 WebpackService |
| `app/service/trace.js` | 核心追踪逻辑入口 |
| `app/lib/scriptAST.js` | 脚本 AST 分析与提纯 |
| `app/lib/WebpackService.js` | Webpack 依赖图服务 |
| `app/lib/PromptService.js` | AI 提示词构造 |
| `config/config.default.js` | Egg 配置（端口、CORS、项目路径） |
