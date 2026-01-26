/**
 * LLM Service：对接大模型分析
 *
 * 迁移说明：
 * - 旧版 Express 直接在路由里调用 runAIAnalysis；
 * - 这里封装成 Egg Service，便于未来：
 *   1) 统一熔断/超时控制
 *   2) 统一日志与埋点
 *   3) 方便在单测里 mock
 */

'use strict';

const Service = require('egg').Service;

/**
 * 本文件负责“大模型调用的可靠性与一致性”治理（属于横切能力）：
 * - 限流：避免频繁点击导致请求堆积把模型打爆
 * - 超时：避免单次调用卡死拖慢接口
 * - 重试：针对临时性错误（网络抖动、429、5xx）做有限重试
 * - 熔断：当模型持续失败时短时间停止调用，直接返回降级结果，防止雪崩
 *
 * 为什么不放在 PromptService：
 * - PromptService 更像“如何组装 prompt + 结构化解析”的纯逻辑层
 * - Service 层更适合做超时/熔断/限流这种面向接口稳定性的控制
 */

/**
 * 可通过环境变量快速调参：
 * - LLM_TIMEOUT_MS：单次模型调用超时
 * - LLM_MAX_RETRIES：最多重试次数（不含首试）
 * - LLM_MAX_CONCURRENCY：最大并发
 * - LLM_CIRCUIT_OPEN_MS：熔断打开后持续时间
 * - LLM_CIRCUIT_FAILURE_THRESHOLD：触发熔断的连续失败阈值
 */
const DEFAULT_TIMEOUT_MS = Number.parseInt(process.env.LLM_TIMEOUT_MS || '30000', 10);
const MAX_RETRIES = Number.parseInt(process.env.LLM_MAX_RETRIES || '2', 10);
const MAX_CONCURRENCY = Number.parseInt(process.env.LLM_MAX_CONCURRENCY || '2', 10);
const CIRCUIT_OPEN_MS = Number.parseInt(process.env.LLM_CIRCUIT_OPEN_MS || '30000', 10);
const CIRCUIT_FAILURE_THRESHOLD = Number.parseInt(process.env.LLM_CIRCUIT_FAILURE_THRESHOLD || '3', 10);

let active = 0;
const waiters = [];

/**
 * 简易熔断器（进程内内存态）：
 * - CLOSED：正常请求
 * - OPEN：熔断打开，直接降级返回，不请求模型
 * - HALF_OPEN：探测态，只放行 1 次请求；成功关闭熔断，失败继续打开
 */
const circuit = {
  state: 'CLOSED',
  openedAt: 0,
  failures: 0,
  halfOpenInFlight: false,
};

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function acquire() {
  // 简易并发控制：超过 MAX_CONCURRENCY 的请求排队等待
  if (active < MAX_CONCURRENCY) {
    active += 1;
    return () => {
      active -= 1;
      const w = waiters.shift();
      if (w) w();
    };
  }
  await new Promise(resolve => waiters.push(resolve));
  active += 1;
  return () => {
    active -= 1;
    const w = waiters.shift();
    if (w) w();
  };
}

function withTimeout(promise, timeoutMs) {
  // 用 Promise.race 实现硬超时；超时后抛出带 code 的错误，便于识别是否可重试
  const ms = Number.isFinite(timeoutMs) ? timeoutMs : DEFAULT_TIMEOUT_MS;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const err = new Error('LLM_TIMEOUT');
      err.code = 'LLM_TIMEOUT';
      setTimeout(() => reject(err), ms);
    }),
  ]);
}

function isRetryableError(err) {
  // 可重试错误：超时/429/5xx/常见网络异常
  if (!err) return false;
  if (err.code === 'LLM_TIMEOUT') return true;
  const status = err.status || err.statusCode || err.response?.status;
  if (status && [ 429, 500, 502, 503, 504 ].includes(status)) return true;
  const msg = String(err.message || '');
  if (/429|rate limit|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN/i.test(msg)) return true;
  return false;
}

function shouldBypassCircuit() {
  // 根据熔断状态决定是否允许本次请求触发模型调用
  const now = Date.now();
  if (circuit.state === 'OPEN') {
    if (now - circuit.openedAt >= CIRCUIT_OPEN_MS) {
      circuit.state = 'HALF_OPEN';
      circuit.halfOpenInFlight = false;
      return true;
    }
    return false;
  }
  if (circuit.state === 'HALF_OPEN') {
    if (circuit.halfOpenInFlight) return false;
    circuit.halfOpenInFlight = true;
    return true;
  }
  return true;
}

function onCircuitSuccess() {
  // 一旦成功，恢复到 CLOSED 并清空失败计数
  circuit.state = 'CLOSED';
  circuit.failures = 0;
  circuit.openedAt = 0;
  circuit.halfOpenInFlight = false;
}

function onCircuitFailure() {
  // 失败累计到阈值（或 HALF_OPEN 探测失败）即打开熔断
  circuit.failures += 1;
  circuit.halfOpenInFlight = false;
  if (circuit.state === 'HALF_OPEN' || circuit.failures >= CIRCUIT_FAILURE_THRESHOLD) {
    circuit.state = 'OPEN';
    circuit.openedAt = Date.now();
  }
}

function toDegradedAnalysis(reason) {
  // 降级结果：保证 controller/service 不崩，接口仍能返回可用结构
  return {
    error: 'LLM 降级返回',
    errorCode: reason,
    fullLinkTrace: '大模型暂不可用，已返回降级结果；可稍后重试。',
    dataSource: {
      type: 'UNKNOWN',
      endpoint: null,
      method: 'UNKNOWN',
    },
    componentAnalysis: [],
  };
}

class LlmService extends Service {
  /**
   * 调用大模型进行链路分析
   * @param {Object} params
   * @param {string} params.finalCodeForAI 提纯后的跨文件代码
   * @param {string} params.targetElement 用户点击的目标 DOM 片段
   * @param {Object} params.traceChains 多链路追踪结果（content/attributes/conditionals）
   */
  async analyze({ finalCodeForAI, targetElement, traceChains }) {
    if (!shouldBypassCircuit()) {
      return toDegradedAnalysis('LLM_CIRCUIT_OPEN');
    }

    const release = await acquire();
    const startAt = Date.now();

    try {
      const { runAIAnalysis } = require('../lib/PromptService');

      let lastError = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
        try {
          // 注意：runAIAnalysis 内部会进行"结构化解析失败自修复"，这里主要管调用可靠性
          const result = await withTimeout(
            Promise.resolve(runAIAnalysis(finalCodeForAI, targetElement, traceChains)),
            DEFAULT_TIMEOUT_MS
          );
          onCircuitSuccess();
          return result;
        } catch (err) {
          lastError = err;
          if (attempt >= MAX_RETRIES || !isRetryableError(err)) break;
          // 指数退避：避免立即重试造成放大
          await delay(300 * Math.pow(2, attempt));
        }
      }

      onCircuitFailure();
      this.ctx.logger.error('[llm] 调用失败:', lastError);
      return toDegradedAnalysis('LLM_CALL_FAILED');
    } finally {
      const cost = Date.now() - startAt;
      if (cost > 0) {
        this.ctx.logger.info(`[llm] cost=${cost}ms state=${circuit.state} failures=${circuit.failures}`);
      }
      release();
    }
  }
}

module.exports = LlmService;
