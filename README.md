# AI-Trace 功能文档

## 1. 功能概述

AI-Trace 是一个用于分析 Vue 应用中数据流转路径的智能工具，它能够从 UI 元素反向追踪到数据源头（API、Store 或静态数据），并生成结构化的分析报告。

### 核心价值
- 快速定位数据来源，提高调试效率
- 可视化数据流转路径，加深对业务逻辑的理解
- 自动生成文档，便于团队协作和知识传递

## 2. 技术栈

| 技术/库 | 用途 |
|---------|------|
| Node.js + Express | 搭建 HTTP 服务 |
| @vue/compiler-sfc | 解析 Vue 单文件组件 |
| @vue/compiler-core | 生成模板 AST |
| @babel/parser | 解析 JavaScript 代码 |
| @babel/traverse | 遍历和分析 AST |
| @babel/generator | 从 AST 生成代码 |
| LangChain | 调用大语言模型 |
| Zod | 定义和验证输出格式 |

## 3. 工作原理

AI-Trace 的工作流程可以分为以下几个主要步骤：

### 3.1 请求处理

服务启动后，监听 `/api/analyze` 接口，接收前端传来的请求参数：
- `path`：Vue 组件文件路径
- `line`：目标元素所在行号
- `column`：目标元素所在列号

### 3.2 AST 分析

#### 3.2.1 什么是 AST？

AST（抽象语法树）是源代码的结构化表示，它将代码转换为树状数据结构，便于程序进行分析和处理。

例如，对于模板 `<div :title="name">{{ age }}</div>`，AST 会将其表示为：
```
ElementNode {
  type: 1,
  tag: 'div',
  props: [
    DirectiveNode {
      name: 'bind',
      arg: { content: 'title' },
      exp: { content: 'name' }
    }
  ],
  children: [
    InterpolationNode {
      content: { content: 'age' }
    }
  ]
}
```

#### 3.2.2 模板 AST 分析

1. 使用 `@vue/compiler-sfc` 解析 Vue 单文件组件
2. 使用 `@vue/compiler-core` 的 `baseParse` 生成模板 AST
3. 调用 `findNodeInTemplate` 函数，根据行号和列号定位目标元素
4. 提取目标元素的标签名、属性和子节点

#### 3.2.3 变量提取

调用 `getUniversalVariables` 函数，从目标元素中提取相关变量：
1. 扫描元素属性（如 `:title="name"` 中的 `name`）
2. 扫描插值表达式（如 `{{ age }}` 中的 `age`）
3. 处理 `v-for` 别名，进行变量溯源

#### 3.2.4 脚本 AST 分析

调用 `pruneScript` 函数，对脚本代码进行提纯：
1. 使用 `@babel/parser` 生成脚本 AST
2. 基于目标变量进行依赖追踪，确定需要保留的代码
3. 剔除无关代码，只保留与目标变量相关的逻辑
4. 对 `props`、`computed`、`methods` 等进行精细化处理
5. 使用 `@babel/generator` 从提纯后的 AST 生成代码

### 3.3 组件溯源

1. 判断变量是否来自 `props`（调用 `isFromProps` 函数）
2. 如果是，通过 `WebpackService` 查找父组件
3. 在父组件中查找对子组件的调用（调用 `findBindingInParent` 函数）
4. 提取父组件中传递给子组件的变量
5. 重复上述过程，直到找到数据源头

### 3.4 大模型调用

#### 3.4.1 什么是大模型调用？

大模型调用是指向预训练的大型语言模型发送请求，获取智能分析结果的过程。AI-Trace 使用 LangChain 框架简化调用流程。

#### 3.4.2 调用流程

1. 构造适合 AI 分析的代码片段，包含：
   - 组件文件路径
   - 模板中调用子组件的代码
   - 关联的脚本逻辑
2. 从代码中提取潜在接口信息
3. 定义输出格式（使用 Zod 模式）
4. 构造多层级提示词（Prompt），包含：
   - 角色定义
   - 任务描述
   - 分析要求
   - 输出格式
   - 源代码
   - 接口信息
   - 最终提醒
5. 使用 LangChain 调用大模型
6. 解析和验证 AI 返回的结果

## 4. 核心模块详解

### 4.1 index.js

主入口文件，负责：
- 启动 Express 服务
- 处理 HTTP 请求
- 协调各模块工作
- 调用 AI 分析服务
- 返回分析结果

### 4.2 templateAST.js

模板 AST 分析模块，提供：
- `findNodeInTemplate`：根据行号和列号定位目标元素

### 4.3 scriptAST.js

脚本 AST 分析模块，提供：
- `pruneScript`：提纯脚本代码，只保留与目标变量相关的逻辑
- `getTemplateVariables`：从模板中提取变量（备用）

### 4.4 variableAST.js

变量处理模块，提供：
- `getUniversalVariables`：从目标元素中提取并溯源变量
- `extractAllIdentifiers`：提取表达式中的所有标识符
- `resolveVariableSource`：解析变量来源

### 4.5 traceUtils.js

工具函数模块，提供：
- `isFromProps`：判断变量是否来自 props
- `findBindingInParent`：在父组件中查找对子组件的调用

### 4.6 PromptService.js

AI 分析服务模块，提供：
- `runAIAnalysis`：调用大模型进行智能分析

## 5. 数据流转示例

假设有以下组件层级：

```
Parent.vue → Child.vue → GrandChild.vue
```

当用户点击 GrandChild.vue 中的某个元素时，AI-Trace 的分析流程如下：

1. **定位元素**：在 GrandChild.vue 中定位目标元素
2. **提取变量**：假设元素使用了变量 `amount`
3. **分析脚本**：发现 `amount` 来自 props
4. **溯源父组件**：在 Child.vue 中找到 `<GrandChild :amount="info.amount" />`
5. **提取变量**：发现 `info` 来自 API 请求
6. **构造代码片段**：生成包含 Parent.vue、Child.vue、GrandChild.vue 相关代码的片段
7. **AI 分析**：调用大模型分析数据流转路径
8. **返回结果**：生成结构化的分析报告

## 6. API 文档

### 6.1 POST /api/analyze

**请求参数**：

| 参数名 | 类型 | 必填 | 描述 |
|--------|------|------|------|
| path | string | 是 | Vue 组件文件相对路径 |
| line | number | 是 | 目标元素所在行号 |
| column | number | 是 | 目标元素所在列号 |

**响应示例**：

```json
{
  "message": "分析成功",
  "targetElement": "<div class=\"amount\">{{ amount }}</div>",
  "traceChain": [
    {
      "file": "src/components/GrandChild.vue",
      "tag": "div",
      "prunedScript": "// File: src/components/GrandChild.vue\n// [Logic] 关联的脚本逻辑:\nconst props = defineProps(['amount']);",
      "source": "<div class=\"amount\">{{ amount }}</div>",
      "callSnippet": "<GrandChild :amount=\"info.amount\" />"
    },
    // ... 更多组件信息
  ],
  "aiAnalysis": {
    "fullLinkTrace": "数据从 API /api/orders 获取，通过 Parent.vue 传递给 Child.vue，最后在 GrandChild.vue 中显示",
    "dataSource": {
      "type": "API",
      "endpoint": "/api/orders",
      "method": "GET"
    },
    "componentAnalysis": [
      {
        "file": "src/components/Parent.vue",
        "role": "容器组件",
        "dataMapping": "API 响应 → info"
      },
      // ... 更多组件分析
    ]
  },
  "finalCodeForAI": "// File: src/components/Parent.vue\n// [Logic] 关联的脚本逻辑:\nimport { ref, onMounted } from 'vue';\nimport request from '@/utils/request';\nimport { METHOD } from '@/utils/http';\n\nconst info = ref({});\nonMounted(async () => {\n  const res = await request('/api/orders', METHOD.GET);\n  info.value = res.data;\n});\nexport default {\n  name: 'Parent',\n  setup() {\n    return { info };\n  }\n};",
}
```

## 7. 配置说明

### 7.1 环境变量

创建 `.env` 文件，配置以下环境变量：

```
AI_API_KEY=your-api-key
AI_BASE_URL=your-api-base-url
AI_MODEL_NAME=your-model-name
```

### 7.2 Webpack 依赖地图

需要在项目根目录生成 `stats.json` 文件，用于组件溯源：

```bash
npx webpack --profile --json > stats.json
```

## 8. 如何使用

1. 启动服务：
   ```bash
   cd ai-trace
   node index.js
   ```

2. 服务将在 `http://localhost:3000` 启动

3. 发送 POST 请求到 `/api/analyze` 接口，获取分析结果

## 9. 关键概念解释

### 9.1 AST（抽象语法树）

AST 是源代码的结构化表示，它将代码转换为树状数据结构，便于程序进行分析和处理。

**为什么需要 AST？**
- 直接分析源代码字符串非常困难
- AST 提供了结构化的访问方式
- 便于进行代码转换和优化

**AI-Trace 中的 AST 应用**：
- 模板 AST：定位目标元素，提取变量
- 脚本 AST：提纯代码，只保留相关逻辑

### 9.2 代码提纯

代码提纯是指从原始代码中提取与目标变量相关的部分，去除无关代码，减少噪声。

**提纯规则**：
- 保留与目标变量直接相关的代码
- 剔除 components、i18n、directives 等非业务逻辑
- 只保留包含业务变量的 props、computed、methods
- 过滤掉不相关的生命周期钩子

### 9.3 大模型调用

大模型调用是指向预训练的大型语言模型发送请求，获取智能分析结果的过程。

**AI-Trace 中的大模型应用**：
- 分析数据流转路径
- 识别数据来源
- 生成结构化报告
- 解释组件间数据映射关系

## 10. 常见问题

### 10.1 为什么分析结果不准确？

可能原因：
- 代码过于复杂，AST 分析受限
- 变量名过于通用，难以追踪
- 大模型理解偏差

解决方案：
- 优化代码结构，减少复杂度
- 使用更具描述性的变量名
- 调整提示词，提高分析准确性

### 10.2 服务启动失败？

检查：
- 环境变量是否正确配置
- stats.json 文件是否存在
- 端口 3000 是否被占用

### 10.3 分析速度慢？

可能原因：
- 组件层级过深
- 代码量过大
- 大模型响应慢

解决方案：
- 限制分析深度
- 优化代码结构
- 考虑使用更快的大模型

## 11. 未来规划

- [ ] 支持更多框架（React、Angular）
- [ ] 提供可视化界面
- [ ] 支持实时分析
- [ ] 优化大模型调用成本
- [ ] 支持更多数据源类型

## 12. 贡献指南

欢迎提交 Issue 和 Pull Request！

### 开发流程

1. 克隆代码
2. 安装依赖
3. 编写代码
4. 测试
5. 提交 PR

### 测试命令

```bash
# 运行服务
node index.js

# 发送测试请求
curl -X POST http://localhost:3000/api/analyze -H "Content-Type: application/json" -d '{"path": "src/components/Example.vue", "line": 10, "column": 5}'
```

## 13. 许可证

MIT
