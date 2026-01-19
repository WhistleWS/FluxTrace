/**
 * 默认配置（开发/生产通用）
 *
 * 迁移说明：
 * - Express 版本固定监听 3000 端口；为了保持前端不改配置，这里也默认用 3000。
 * - 旧逻辑里 PROJECT_ROOT = path.resolve(__dirname, '..')（ai-trace 的上一级，也就是 vue-antd-admin 根目录）
 *   Egg 下 baseDir 是 ai-trace，因此 projectRoot 默认仍取 baseDir 的上一级。
 */

'use strict';

const path = require('path');

module.exports = appInfo => {
  const config = {};

  config.keys = appInfo.name + '_1737000000000_egg_keys';

  // 让 Egg 监听端口与 Express 保持一致，避免前端改端口
  config.cluster = {
    listen: {
      port: Number(process.env.PORT) || 3000,
      hostname: '0.0.0.0',
    },
  };

  // 提供一个统一的“项目根目录”供溯源使用（即 vue-antd-admin 根目录）
  config.projectRoot = process.env.PROJECT_ROOT
    ? path.resolve(process.env.PROJECT_ROOT)
    : path.resolve(appInfo.baseDir, '..');

  // CORS：允许前端跨域调用
  config.cors = {
    origin: '*',
    allowMethods: 'GET,HEAD,PUT,POST,DELETE,PATCH,OPTIONS',
    credentials: false,
  };

  // 纯 API 服务，关闭 CSRF，避免跨域/前端无 token 时被拦截
  config.security = {
    csrf: {
      enable: false,
    },
  };

  // JSON Body 体积上限（按需调整）
  config.bodyParser = {
    jsonLimit: '10mb',
    formLimit: '10mb',
    textLimit: '10mb',
  };

  return config;
};

