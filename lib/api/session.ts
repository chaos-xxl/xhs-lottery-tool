/**
 * 每次 API 调用的 XhsClient / SecureStore 会话组装
 *
 * 避免每个 route 重复写 "读 Cookie → 解密 → 组 client" 的样板。
 */

import { type CookieBundle, SecureStore } from '../config/secure-store';
import { XhsClient } from '../xhs/client';
import { CookieMonitor } from '../xhs/cookie-monitor';
import { RateLimiter } from '../xhs/rate-limiter';
import type { XhsClientLike } from '../xhs/types';

// 进程级单例（自用单用户场景足够）
let cachedLimiter: RateLimiter | null = null;
let cachedMonitor: { client: XhsClient; monitor: CookieMonitor } | null = null;

export function getRateLimiter(): RateLimiter {
  if (!cachedLimiter) cachedLimiter = new RateLimiter();
  return cachedLimiter;
}

export interface XhsSession {
  readonly store: SecureStore;
  readonly cookie: CookieBundle;
  readonly client: XhsClient;
  readonly monitor: CookieMonitor;
  readonly currentUserId: string | null;
}

/**
 * 读取本地 Cookie、组装一个可用的 XhsClient + 监控器。
 *
 * 注意：`allowStubSign` 默认取环境变量 `XHS_ALLOW_STUB_SIGN`，生产应保持关闭。
 */
export function openSession(): XhsSession {
  const store = new SecureStore();
  const cookie = store.getCookie();
  const meta = store.getMeta();

  const limiter = getRateLimiter();
  // 优先使用存储的完整 Cookie 字符串（_raw 字段）
  let cookieStr = (cookie as Record<string, string>)._raw ?? '';

  if (!cookieStr) {
    // 从对象构建，保留所有字段
    const entries = Object.entries(cookie).filter(([k]) => k !== '_raw');
    cookieStr = entries.map(([k, v]) => `${k}=${v}`).join('; ');
  }

  // 确保包含必要的签名字段
  const requiredFields = ['web_session', 'a1', 'webId'];
  const missingFields = requiredFields.filter(f => !cookieStr.includes(`${f}=`));
  if (missingFields.length > 0) {
    console.warn('[Session] Cookie missing required fields:', missingFields);
  }

  const client = new XhsClient({
    cookie: cookieStr,
    a1: cookie.a1,
    rateLimiter: limiter,
  });

  const monitor = reuseOrCreateMonitor(client);

  return {
    store,
    cookie,
    client,
    monitor,
    currentUserId: meta?.accountUserId ?? null,
  };
}

/**
 * 不需要 Cookie 的场景：只组一个 RateLimiter + 监视器壳（probe 时再调）。
 */
export function openLightClient(externalClient?: XhsClientLike): XhsClientLike | null {
  return externalClient ?? null;
}

function reuseOrCreateMonitor(client: XhsClient): CookieMonitor {
  if (cachedMonitor && cachedMonitor.client === client) return cachedMonitor.monitor;
  const monitor = new CookieMonitor(client);
  cachedMonitor = { client, monitor };
  return monitor;
}

/**
 * 测试 / 自毁完成后清理进程缓存。
 */
export function resetSessionCache(): void {
  cachedLimiter = null;
  cachedMonitor = null;
}
