# FluxTrace Client SDK

Vue 数据流追踪工具的前端 SDK，配合 `code-inspector-plugin` 使用，实现从 UI 元素反向追踪到数据源头。

## 安装

```bash
# 本地引用（推荐）
# 直接从 FluxTrace/client 目录引入

# 或发布到 npm 后
npm install @anthropic/FluxTrace-client
```

## 前置依赖

需要在项目中安装并配置 `code-inspector-plugin`：

```bash
npm install code-inspector-plugin -D
```

## 使用方式

### 方式 A：SDK 引入（推荐）

在项目入口文件（如 `main.ts`）中初始化：

```typescript
import { initFluxTrace } from '../FluxTrace/client';
// 或 npm 安装后: import { initFluxTrace } from '@anthropic/FluxTrace-client';

initFluxTrace({
  baseUrl: 'http://localhost:3000',  // 可选，FluxTrace 后端地址
  onlyDev: true,                      // 可选，默认仅开发环境生效
  silent: false,                      // 可选，是否静默模式
  onSuccess: (result) => {            // 可选，分析成功回调
    console.log('分析结果:', result);
  },
  onError: (error) => {               // 可选，分析失败回调
    console.error('分析失败:', error);
  }
});
```

### 方式 B：Webpack 插件（零配置）

在 `vue.config.js` 中配置：

```javascript
const { createFluxTracePlugins } = require('./FluxTrace/plugins/webpack');

module.exports = {
  configureWebpack: {
    plugins: [
      ...createFluxTracePlugins({ port: 3000 })
    ]
  }
};
```

## API

### `initFluxTrace(options)`

初始化 SDK，自动监听 `code-inspector:trackCode` 事件。

| 参数 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| baseUrl | string | `'http://localhost:3000'` | FluxTrace 后端服务地址 |
| onlyDev | boolean | `true` | 是否仅在开发环境生效 |
| silent | boolean | `false` | 是否静默模式（不输出日志） |
| onSuccess | function | `null` | 分析成功回调 |
| onError | function | `null` | 分析失败回调 |

### `analyze(params)`

手动触发分析，用于编程式调用。

```typescript
import { analyze } from '../FluxTrace/client';

const result = await analyze({
  path: 'src/views/Home.vue',
  line: 10,
  column: 5,
  baseUrl: 'http://localhost:3000'  // 可选
});
```

## 工作流程

1. 用户按住快捷键（默认 Option/Alt）点击页面元素
2. `code-inspector-plugin` 触发 `code-inspector:trackCode` 事件
3. SDK 捕获事件，向 FluxTrace 后端发送分析请求
4. 后端返回数据流追踪结果

## License

MIT
