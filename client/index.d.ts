/**
 * FluxTrace SDK 配置选项
 */
export interface FluxTraceOptions {
  /** FluxTrace 后端服务地址，默认 'http://localhost:3000' */
  baseUrl?: string;
  /** 是否仅在开发环境生效，默认 true */
  onlyDev?: boolean;
  /** 分析成功回调 */
  onSuccess?: (result: any) => void;
  /** 分析失败回调 */
  onError?: (error: Error) => void;
  /** 是否静默模式（不输出日志），默认 false */
  silent?: boolean;
}

/**
 * 分析参数
 */
export interface AnalyzeParams {
  /** 文件路径 */
  path: string;
  /** 行号 */
  line: number;
  /** 列号 */
  column: number;
  /** 后端服务地址 */
  baseUrl?: string;
}

/**
 * 初始化 FluxTrace SDK
 * @param options - 配置选项
 */
export function initFluxTrace(options?: FluxTraceOptions): void;

/**
 * 手动触发分析（用于编程式调用）
 * @param params - 分析参数
 */
export function analyze(params: AnalyzeParams): Promise<any>;

declare const _default: {
  initFluxTrace: typeof initFluxTrace;
  analyze: typeof analyze;
};

export default _default;
