/**
 * 应用启动钩子
 *
 * 迁移说明：
 * - WebpackService.init(statsPath) 在 Express 版入口里是启动时执行一次；
 * - Egg 里推荐在 app.beforeStart 里做一次性初始化，避免每个请求重复构建依赖图。
 */

'use strict';

const path = require('path');

module.exports = app => {
  app.beforeStart(async () => {
    const webpackService = require('./app/lib/WebpackService');

    const statsPath = path.resolve(app.config.projectRoot, './stats.json');

    if (typeof webpackService.setProjectRoot === 'function') {
      webpackService.setProjectRoot(app.config.projectRoot);
    }

    // WebpackService 内部已做 try/catch 与降级逻辑，这里 await 只保证初始化顺序
    await webpackService.init(statsPath);
    app.coreLogger.info('[ai-trace] Webpack 依赖图初始化完成');
  });
};
