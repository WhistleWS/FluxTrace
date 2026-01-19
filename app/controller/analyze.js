/**
 * AI-Trace 分析入口 Controller
 *
 * 迁移说明：
 * - 旧版 Express 直接在 index.js 里实现 /api/analyze 的所有逻辑；
 * - Egg 推荐做法是把 HTTP 层（参数获取/状态码/响应结构）放在 controller，
 *   业务逻辑下沉到 service，便于测试与复用。
 */

'use strict';

const Controller = require('egg').Controller;

class AnalyzeController extends Controller {
  /**
   * /api/analyze
   *
   * 兼容 Express 旧行为：
   * - 支持 query/body 同时读取 path
   * - line/column 从 query 读取（与前端点击坐标匹配）
   */
  async index() {
    const { ctx } = this;

    const currentRelativePath = ctx.query.path || (ctx.request.body && ctx.request.body.path);
    const line = Number.parseInt(ctx.query.line, 10);
    const column = Number.parseInt(ctx.query.column, 10);

    if (!currentRelativePath) {
      ctx.status = 400;
      ctx.body = { error: '缺少文件路径' };
      return;
    }

    try {
      const result = await ctx.service.trace.analyze({
        path: currentRelativePath,
        line,
        column,
      });

      ctx.body = result;
    } catch (err) {
      ctx.logger.error('[analyze] 分析失败:', err);
      ctx.status = 500;
      ctx.body = { error: '服务器内部错误' };
    }
  }
}

module.exports = AnalyzeController;

