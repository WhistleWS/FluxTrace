/**
 * 路由定义
 *
 * 迁移说明：
 * - Express 版本使用 app.all('/api/analyze', ...) 以兼容 GET/POST；
 * - Egg 版本同样使用 router.all，确保与旧前端调用方式完全一致。
 */

'use strict';

module.exports = app => {
  const { router, controller } = app;
  router.all('/api/analyze', controller.analyze.index);
};

