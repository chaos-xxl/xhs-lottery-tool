/**
 * Cookie 健康度自检（Cookie Monitor）
 *
 * 对应 requirements.md R2（Cookie 健康度自检）、R16（状态徽标）。
 *
 * 职责：
 *   - 提供 `probe()`：调用自我状态接口探测账号可用性
 *   - 维护状态机：healthy / expiring_soon / expired / challenge_required / unknown
 *   - 触发 461 → 置 challenge_required，开启冷却戳（默认 24 小时）
 *   - 触发 401/403 → 置 expired
 *   - Cookie 距过期 < 3 天 → 置 expiring_soon
 *   - 订阅 onChange 事件，UI 徽标根据状态切换颜色
 *   - 在冷却期内的 probe 不再打真实请求（只返回缓存状态）
 */

import { ENDPOINTS } from './endpoints';
import {
  type SelfInfoResponse,
  XhsAuthError,
  type XhsClientLike,
  XhsRiskControlError,
} from './types';

// ============================================================================
// State
// ============================================================================

export type CookieStatus =
  | 'healthy'
  | 'expiring_soon'
  | 'expired'
  | 'challenge_required'
  | 'unknown';

export interface CookieHealthMeta {
  /** 最近一次 probe 的结果（包括失败时的状态） */
  readonly status: CookieStatus;
  /** 最近一次 probe 的本地时间 unix ms；null 表示从未探测 */
  readonly lastProbedAt: number | null;
  /** 探测成功时保存的账号 user_id */
  readonly accountUserId: string | null;
  /** challenge_required 下的冷却到期时间 unix ms；非该状态时为 0 */
  readonly cooldownUntil: number;
  /** Cookie 距过期剩余毫秒；>0 表示还有 n ms，≤0 表示已过期 */
  readonly expiresInMs: number | null;
}

export type CookieStatusListener = (meta: CookieHealthMeta) => void;

// ============================================================================
// Options
// ============================================================================

export interface CookieMonitorOptions {
  readonly now?: () => number;
  /** 默认 24 小时 */
  readonly challengeCooldownMs?: number;
  /** 即将过期阈值（默认 3 天） */
  readonly expiringSoonThresholdMs?: number;
}

export const DEFAULT_CHALLENGE_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_EXPIRING_SOON_THRESHOLD_MS = 3 * 24 * 60 * 60 * 1000;

// ============================================================================
// CookieMonitor
// ============================================================================

export class CookieMonitor {
  private meta: CookieHealthMeta = {
    status: 'unknown',
    lastProbedAt: null,
    accountUserId: null,
    cooldownUntil: 0,
    expiresInMs: null,
  };

  private listeners = new Set<CookieStatusListener>();

  private readonly now: () => number;
  private readonly challengeCooldownMs: number;
  private readonly expiringSoonThresholdMs: number;

  constructor(
    private readonly client: XhsClientLike,
    options: CookieMonitorOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.challengeCooldownMs = options.challengeCooldownMs ?? DEFAULT_CHALLENGE_COOLDOWN_MS;
    this.expiringSoonThresholdMs =
      options.expiringSoonThresholdMs ?? DEFAULT_EXPIRING_SOON_THRESHOLD_MS;
  }

  getStatus(): CookieHealthMeta {
    return this.meta;
  }

  /**
   * 订阅状态变化。返回取消订阅函数。
   */
  onChange(listener: CookieStatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * 主动探测一次。
   *
   * 冷却期内不发真实请求，直接返回缓存状态（但会检查是否已过冷却时间）。
   *
   * @param cookieExpiresAt 可选：Cookie 的预估过期时间 unix ms（用于 expiring_soon 判断）
   */
  async probe(cookieExpiresAt?: number): Promise<CookieHealthMeta> {
    // 冷却期内：不打接口
    if (this.inCooldown()) {
      return this.updateMeta({
        status: 'challenge_required',
        cooldownUntil: this.meta.cooldownUntil,
      });
    }

    let selfInfo: SelfInfoResponse | null = null;
    let errStatus: CookieStatus | null = null;

    try {
      selfInfo = await this.client.get<SelfInfoResponse>(ENDPOINTS.selfInfo);
    } catch (err) {
      if (err instanceof XhsAuthError) {
        errStatus = 'expired';
      } else if (err instanceof XhsRiskControlError) {
        errStatus = 'challenge_required';
      } else {
        errStatus = 'unknown';
      }
    }

    const nowMs = this.now();

    if (errStatus === 'challenge_required') {
      return this.updateMeta({
        status: 'challenge_required',
        lastProbedAt: nowMs,
        cooldownUntil: nowMs + this.challengeCooldownMs,
      });
    }

    if (errStatus === 'expired') {
      return this.updateMeta({
        status: 'expired',
        lastProbedAt: nowMs,
        cooldownUntil: 0,
      });
    }

    if (errStatus === 'unknown') {
      return this.updateMeta({
        status: 'unknown',
        lastProbedAt: nowMs,
      });
    }

    // 成功：根据 account_status + 过期时间综合判定
    if (selfInfo?.account_status === 'limited' || selfInfo?.account_status === 'banned') {
      return this.updateMeta({
        status: 'expired',
        lastProbedAt: nowMs,
        accountUserId: selfInfo.user_id ?? null,
      });
    }

    let status: CookieStatus = 'healthy';
    let expiresInMs: number | null = null;
    if (typeof cookieExpiresAt === 'number') {
      expiresInMs = cookieExpiresAt - nowMs;
      if (expiresInMs <= 0) {
        status = 'expired';
      } else if (expiresInMs <= this.expiringSoonThresholdMs) {
        status = 'expiring_soon';
      }
    }

    return this.updateMeta({
      status,
      lastProbedAt: nowMs,
      accountUserId: selfInfo?.user_id ?? this.meta.accountUserId,
      cooldownUntil: 0,
      expiresInMs,
    });
  }

  /**
   * 外部模块识别到 461 时可直接记账（不用再走 probe）。
   */
  recordRiskControl(): void {
    const nowMs = this.now();
    this.updateMeta({
      status: 'challenge_required',
      lastProbedAt: nowMs,
      cooldownUntil: nowMs + this.challengeCooldownMs,
    });
  }

  /**
   * 外部模块识别到 401/403 时记账。
   */
  recordAuthFailure(): void {
    this.updateMeta({
      status: 'expired',
      lastProbedAt: this.now(),
    });
  }

  // ------------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------------

  private inCooldown(): boolean {
    return this.now() < this.meta.cooldownUntil;
  }

  private updateMeta(patch: Partial<CookieHealthMeta>): CookieHealthMeta {
    const next: CookieHealthMeta = { ...this.meta, ...patch };
    const changed =
      next.status !== this.meta.status ||
      next.cooldownUntil !== this.meta.cooldownUntil ||
      next.accountUserId !== this.meta.accountUserId ||
      next.expiresInMs !== this.meta.expiresInMs;

    this.meta = next;
    if (changed) this.emit();
    return next;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      try {
        listener(this.meta);
      } catch {
        // 监听者出错不应影响其他监听者
      }
    }
  }
}

export function isExpiringSoon(expiresInMs: number, thresholdMs: number = 24 * 60 * 60 * 1000): boolean {
  return expiresInMs < thresholdMs;
}
