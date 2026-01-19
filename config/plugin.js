/**
 * Egg 插件配置
 *
 * 迁移说明：
 * - 该服务是纯 API 服务，需要跨域给前端调用，所以启用 egg-cors。
 */

'use strict';

module.exports = {
  cors: {
    enable: true,
    package: 'egg-cors',
  },
};

