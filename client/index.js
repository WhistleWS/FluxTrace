/**
 * FluxTrace 前端 SDK
 * Vue 数据流追踪工具客户端
 *
 * 使用方式：
 * import { initFluxTrace } from '@anthropic/FluxTrace-client';
 * initFluxTrace({ baseUrl: 'http://localhost:3000' });
 */

/**
 * 初始化 FluxTrace SDK
 * @param {Object} options - 配置选项
 * @param {string} options.baseUrl - FluxTrace 后端服务地址，默认 'http://localhost:3000'
 * @param {boolean} options.onlyDev - 是否仅在开发环境生效，默认 true
 * @param {Function} options.onSuccess - 分析成功回调
 * @param {Function} options.onError - 分析失败回调
 * @param {boolean} options.silent - 是否静默模式（不输出日志），默认 false
 */
export function initFluxTrace(options = {}) {
  const {
    baseUrl = 'http://localhost:3000',
    onlyDev = true,
    onSuccess = null,
    onError = null,
    silent = false
  } = options;

  // 仅在开发环境生效
  if (onlyDev && process.env.NODE_ENV === 'production') {
    return;
  }

  // 避免重复初始化
  if (window.__FLUX_TRACE_INITIALIZED__) {
    !silent && console.warn('⚠️ FluxTrace SDK 已初始化，跳过重复初始化');
    return;
  }
  window.__FLUX_TRACE_INITIALIZED__ = true;

  window.addEventListener('code-inspector:trackCode', async (event) => {
    const { path, line, column } = event.detail || {};
    if (!path) return;

    !silent && console.log(`📡 FluxTrace: 分析 ${path}:${line}:${column}`);

    try {
      const response = await fetch(
        `${baseUrl}/api/analyze?path=${encodeURIComponent(path)}&line=${line}&column=${column}`,
        { method: 'GET' }
      );
      const result = await response.json();
      !silent && console.log('✅ FluxTrace 分析完成:', result);
      onSuccess?.(result);
    } catch (error) {
      !silent && console.error('❌ FluxTrace 请求失败:', error);
      onError?.(error);
    }
  });

  !silent && console.log('🔧 FluxTrace SDK 已初始化');
}

/**
 * 手动触发分析（用于编程式调用）
 * @param {Object} params - 分析参数
 * @param {string} params.path - 文件路径
 * @param {number} params.line - 行号
 * @param {number} params.column - 列号
 * @param {string} params.baseUrl - 后端服务地址
 */
export async function analyze({ path, line, column, baseUrl = 'http://localhost:3000' }) {
  if (!path) {
    throw new Error('path 参数是必需的');
  }

  const response = await fetch(
    `${baseUrl}/api/analyze?path=${encodeURIComponent(path)}&line=${line}&column=${column}`,
    { method: 'GET' }
  );
  return response.json();
}

export default { initFluxTrace, analyze };
