/**
 * 请求节奏护栏（Rate Limiter）
 *
 * 对应 requirements.md R3（请求节奏与量级护栏）、R21.1（超时重试）。
 *
 * 职责：
 *   1. 两次请求之间保证最小间隔 1500 ms + 300-800 ms 随机抖动
 *   2. 单账号全局串行队列（防并发同一 cookie）
 *   3. 461 计数器：同会话累计 2 次进入 1 小时冷却，冷却期内 `run` 直接 reject
 *   4. 单次抓取会话累计 ≥ 1000 条时返回 PoolCappedSignal，让上层停止翻页
 *
 * 设计：
 *   - 使用「时钟源」抽象，测试里注入假时钟可精准控制间隔
 *   - 使用「sleep 函数」抽象，测试里替换为 Promise.resolve 立即返回
 *   - 不自己起定时器，所有等待都通过 sleep 抽象，避免测试环境长时间挂起
 */

import { XhsRiskControlError } from './types';

// ============================================================================
// 常量
// ============================================================================

export const MIN_REQUEST_INTERVAL_MS = 1500;
export const JITTER_MIN_MS = 300;
export const JITTER_MAX_MS = 800;
export const CONSECUTIVE_461_LIMIT = 2;
export const COOLDOWN_DURATION_MS = 60 * 60 * 1000; // 1 小时
export const FETCH_ITEM_CAP_PER_SESSION = 1000;

// ============================================================================
// 信号
// ============================================================================

/**
 * 达到单次抓取上限的信号对象（非异常）。
 *
 * 上层收到这个信号应立即停止翻页（而不是抛异常中断）。
 */
export const POOL_CAPPED_SIGNAL = Symbol('POOL_CAPPED_SIGNAL');
export type PoolCappedSignal = typeof POOL_CAPPED_SIGNAL;

// ============================================================================
// Options
// ============================================================================

export interface RateLimiterOptions {
  /** 时钟源：返回当前 unix ms，默认 Date.now */
  readonly now?: () => number;
  /** sleep 函数：默认 setTimeout promise，测试里换成 immediate */
  readonly sleep?: (ms: number) => Promise<void>;
  /** 抖动采样器：默认 Math.random，测试里可用固定值 */
  readonly randomJitter?: () => number;
  /** 最小请求间隔，默认 1500 */
  readonly minIntervalMs?: number;
  /** 冷却时长，默认 3600000 */
  readonly cooldownMs?: number;
  /** 触发冷却所需的连续 461 次数，默认 2 */
  readonly consecutive461Limit?: number;
  /** 单会话上限，默认 1000 */
  readonly itemCapPerSession?: number;
}

// ============================================================================
// RateLimiter
// ============================================================================

export class RateLimiter {
  private lastRequestAt = 0;
  private consecutive461 = 0;
  private cooldownUntil = 0;
  private sessionItemCount = 0;
  /** 串行队列尾部 Promise，新任务挂在尾部等待 */
  private tail: Promise<unknown> = Promise.resolve();

  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly randomJitter: () => number;
  private readonly minIntervalMs: number;
  private readonly cooldownMs: number;
  private readonly consecutive461Limit: number;
  readonly itemCapPerSession: number;

  constructor(options: RateLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.randomJitter = options.randomJitter ?? Math.random;
    this.minIntervalMs = options.minIntervalMs ?? MIN_REQUEST_INTERVAL_MS;
    this.cooldownMs = options.cooldownMs ?? COOLDOWN_DURATION_MS;
    this.consecutive461Limit = options.consecutive461Limit ?? CONSECUTIVE_461_LIMIT;
    this.itemCapPerSession = options.itemCapPerSession ?? FETCH_ITEM_CAP_PER_SESSION;
  }

  /**
   * 在串行队列里执行一个请求函数。
   *
   * - 先检查冷却状态；冷却期内直接 reject
   * - 等到距上次请求 ≥ minInterval + 随机抖动
   * - 执行 fn；根据结果 / 错误更新 461 计数
   */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.tail.then(async () => {
      this.assertNotInCooldown();
      await this.waitForInterval();

      try {
        const result = await fn();
        this.consecutive461 = 0; // 成功一次就重置
        return result;
      } catch (err) {
        if (err instanceof XhsRiskControlError) {
          this.onRiskControl();
        }
        throw err;
      } finally {
        this.lastRequestAt = this.now();
      }
    });

    this.tail = task.catch(() => undefined);
    return task;
  }

  /** 累加本次会话已抓条数 */
  addToSession(count: number): void {
    if (count > 0) this.sessionItemCount += count;
  }

  /** 询问是否已达到单会话上限（到则应返回 POOL_CAPPED_SIGNAL） */
  shouldStopForSessionCap(): boolean {
    return this.sessionItemCount >= this.itemCapPerSession;
  }

  /** 重置单会话计数（开始新的抓取任务前调用） */
  resetSession(): void {
    this.sessionItemCount = 0;
  }

  /** 手动触发一次 461 记账（外部模块在识别到 461 时可调用） */
  recordRiskControl(): void {
    this.onRiskControl();
  }

  /** 读取冷却状态（UI / 监控模块用） */
  getCooldownState(): { inCooldown: boolean; until: number; remainingMs: number } {
    const now = this.now();
    const inCooldown = now < this.cooldownUntil;
    return {
      inCooldown,
      until: this.cooldownUntil,
      remainingMs: inCooldown ? this.cooldownUntil - now : 0,
    };
  }

  // ------------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------------

  private assertNotInCooldown(): void {
    const state = this.getCooldownState();
    if (state.inCooldown) {
      throw new XhsRiskControlError(
        `正在冷却期（剩余 ${Math.ceil(state.remainingMs / 1000)}s），请稍后再试`,
      );
    }
  }

  private async waitForInterval(): Promise<void> {
    if (this.lastRequestAt === 0) return; // 首次请求不等
    const elapsed = this.now() - this.lastRequestAt;
    const jitter = JITTER_MIN_MS + this.randomJitter() * (JITTER_MAX_MS - JITTER_MIN_MS);
    const totalDelay = this.minIntervalMs + jitter;
    if (elapsed < totalDelay) {
      await this.sleep(totalDelay - elapsed);
    }
  }

  private onRiskControl(): void {
    this.consecutive461 += 1;
    if (this.consecutive461 >= this.consecutive461Limit) {
      this.cooldownUntil = this.now() + this.cooldownMs;
      this.consecutive461 = 0; // 冷却激活后重置计数器，避免冷却结束后继续判定
    }
  }
}
