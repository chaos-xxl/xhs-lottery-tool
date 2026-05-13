/**
 * 小红书 Web 私有接口请求客户端
 *
 * 对应 requirements.md R3（请求节奏）、R7.5（错误识别）、R20.3/20.4（日志脱敏 + 域名白名单）、
 * R21.1（超时重试至多 1 次）、R22.1（URI 集中）。
 *
 * 组装：Cookie（secure-store 解密）+ rate-limiter + sign + endpoints
 */

import { setTimeout as delay } from 'node:timers/promises';
import { logger, maskSecret } from '../config/logger';
import { ALLOWED_HOSTS, XHS_API_BASE } from './endpoints';
import type { RateLimiter } from './rate-limiter';
import { type BrowserSignHeaders, getSignBrowser } from './sign-browser';
import { XhsApiError, XhsAuthError, type XhsClientLike, XhsRiskControlError } from './types';

// ============================================================================
// Types
// ============================================================================

export interface XhsClientOptions {
  /** Cookie 串，例如 "web_session=xxx; a1=yyy; webId=zzz" */
  readonly cookie: string;
  /** Cookie 中 a1 字段的值，签名需要 */
  readonly a1: string;
  /** UA 字符串，默认模拟 Chrome on Mac */
  readonly userAgent?: string;
  /** Rate limiter 实例（由 Section 6 API 层注入） */
  readonly rateLimiter: RateLimiter;
  /** 自定义 fetch 实现（测试使用） */
  readonly fetch?: typeof fetch;
  /** 是否允许 stub 签名发起请求（默认 false，生产必须移植真实签名）*/
  readonly allowStubSign?: boolean;
  /** 单次请求超时毫秒数，默认 15000 */
  readonly requestTimeoutMs?: number;
  /** 自定义签名函数（测试注入用）。不传则使用浏览器签名服务。 */
  readonly signFn?: (url: string, data?: unknown) => Promise<Record<string, string>>;
}

interface XhsResponseEnvelope<T> {
  readonly success: boolean;
  readonly code: number;
  readonly msg: string;
  readonly data: T;
}

// ============================================================================
// Errors (local)
// ============================================================================

export class XhsHostNotAllowedError extends Error {
  readonly code = 'xhs_host_not_allowed' as const;

  constructor(host: string) {
    super(`请求目标域名 ${host} 不在白名单内，拒绝访问`);
    this.name = 'XhsHostNotAllowedError';
  }
}

// ============================================================================
// XhsClient
// ============================================================================

const DEFAULT_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

export class XhsClient implements XhsClientLike {
  private readonly cookie: string;
  private readonly a1: string;
  private readonly userAgent: string;
  private readonly rateLimiter: RateLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly allowStubSign: boolean;
  private readonly requestTimeoutMs: number;
  private readonly signFn?: (url: string, data?: unknown) => Promise<Record<string, string>>;

  constructor(options: XhsClientOptions) {
    this.cookie = options.cookie;
    this.a1 = options.a1;
    this.userAgent = options.userAgent ?? DEFAULT_UA;
    this.rateLimiter = options.rateLimiter;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.allowStubSign = options.allowStubSign ?? false;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.signFn = options.signFn;
  }

  /**
   * GET 请求：签名 + 注入 Cookie + rate-limiter 节奏 + 状态码处理。
   */
  async get<T>(uri: string, params?: Record<string, string>): Promise<T> {
    return this.request<T>('GET', uri, params);
  }

  /**
   * POST 请求（某些互动接口需要 POST body）
   */
  async post<T>(uri: string, body: Record<string, unknown>): Promise<T> {
    return this.request<T>('POST', uri, undefined, body);
  }

  // ------------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------------

  private async request<T>(
    method: 'GET' | 'POST',
    uri: string,
    params?: Record<string, string>,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const targetUrl = this.buildUrl(uri, params);
    this.assertAllowedHost(targetUrl);

    return this.rateLimiter.run(async () => {
      // 签名：优先用注入的 signFn（测试），否则用浏览器签名服务（生产）
      const signUrl = params ? `${uri}?${new URLSearchParams(params).toString()}` : uri;
      let signHeaders: Record<string, string>;
      if (this.signFn) {
        signHeaders = await this.signFn(signUrl, body);
      } else {
        const signer = await getSignBrowser({
          cookieString: this.cookie,
          headless: true,
        });
        signHeaders = { ...(await signer.sign(signUrl, body)) } as Record<string, string>;
      }

      const headers: Record<string, string> = {
        ...signHeaders,
        cookie: this.cookie,
        'user-agent': this.userAgent,
        referer: 'https://www.xiaohongshu.com/',
        origin: 'https://www.xiaohongshu.com',
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json;charset=UTF-8',
      };

      logger.debug(
        {
          method,
          uri,
          host: new URL(targetUrl).host,
          cookie_head: maskSecret(this.cookie, 16),
        },
        '发起 XHS Web 请求',
      );

      const res = await this.fetchWithRetry(targetUrl, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });

      return this.parseResponse<T>(res, uri);
    });
  }

  private async fetchWithRetry(url: string, init: Parameters<typeof fetch>[1]): Promise<Response> {
    const timeoutMs = this.requestTimeoutMs;
    const attempt = async (): Promise<Response> => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await this.fetchImpl(url, { ...init, signal: controller.signal });
      } finally {
        clearTimeout(timer);
      }
    };

    try {
      return await attempt();
    } catch (err) {
      // R21.1：仅在网络层错误时重试 1 次；风控/鉴权错误已经在 parseResponse 里抛
      if (!isAbortOrNetworkError(err)) throw err;
      logger.warn({ url: new URL(url).host, err: (err as Error).message }, '网络错误，重试 1 次');
      await delay(500);
      return attempt();
    }
  }

  private async parseResponse<T>(res: Response, uri: string): Promise<T> {
    if (res.status === 461) {
      this.rateLimiter.recordRiskControl();
      throw new XhsRiskControlError();
    }
    if (res.status === 401 || res.status === 403) {
      throw new XhsAuthError();
    }
    if (res.status >= 500) {
      throw new XhsApiError(res.status, `服务端错误：HTTP ${res.status}`);
    }

    let body: XhsResponseEnvelope<T>;
    try {
      body = (await res.json()) as XhsResponseEnvelope<T>;
    } catch {
      throw new XhsApiError(res.status, `响应无法解析为 JSON（HTTP ${res.status}）`);
    }

    if (!body.success) {
      // 小红书常见业务错误码：-1 通用 / -100 登录过期 / -101 签名错误
      if (body.code === -100) throw new XhsAuthError(body.msg);
      throw new XhsApiError(body.code, body.msg);
    }

    logger.debug({ uri, code: body.code }, 'XHS 请求成功');
    return body.data;
  }

  private buildUrl(uri: string, params?: Record<string, string>): string {
    const url = new URL(uri, XHS_API_BASE);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  private assertAllowedHost(url: string): void {
    const host = new URL(url).host;
    if (!ALLOWED_HOSTS.includes(host)) {
      throw new XhsHostNotAllowedError(host);
    }
  }
}

// ============================================================================
// Helpers
// ============================================================================

function isAbortOrNetworkError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'AbortError' ||
    err.message.includes('fetch failed') ||
    err.message.includes('ECONN') ||
    err.message.includes('ETIMEDOUT')
  );
}
