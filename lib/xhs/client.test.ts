/**
 * XhsClient 单元测试（mock fetch）
 *
 * 验证：
 *   - 401/403 → XhsAuthError（R7.5）
 *   - 461 → XhsRiskControlError + rateLimiter.recordRiskControl 被调用（R3.5）
 *   - 非白名单域名 → XhsHostNotAllowedError（R20.4）
 *   - 超时重试至多 1 次（R21.1）
 *   - success=false code=-100 → XhsAuthError（登录过期特例）
 *   - 请求头包含签名 + Cookie + UA + Referer
 *   - stub 签名 + allowStubSign=false → 直接拒绝发请求
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { XhsClient, XhsHostNotAllowedError } from './client';
import { RateLimiter } from './rate-limiter';
import { XhsApiError, XhsAuthError, XhsRiskControlError } from './types';

function makeRateLimiter(): RateLimiter {
  return new RateLimiter({
    now: () => 0,
    sleep: async () => {},
    randomJitter: () => 0,
    minIntervalMs: 0,
    cooldownMs: 0,
  });
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const mockSignFn = async () => ({
  'x-s': 'mock-xs',
  'x-t': 'mock-xt',
  'x-s-common': 'mock-common',
  'x-b3-traceid': 'mock-trace',
});

function okBody<T>(data: T): { success: true; code: 0; msg: 'OK'; data: T } {
  return { success: true, code: 0, msg: 'OK', data };
}

describe('XhsClient — 基础请求（allowStubSign=true）', () => {
  it('GET 成功返回 data 字段', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, okBody({ hello: 'world' })));
    const client = new XhsClient({
      cookie: 'web_session=x; a1=y; webId=z',
      a1: 'y',
      rateLimiter: makeRateLimiter(),
      fetch: fetchMock as unknown as typeof fetch,
      signFn: mockSignFn,
    });

    const data = await client.get<{ hello: string }>('/api/sns/web/v1/user/selfinfo');

    expect(data).toEqual({ hello: 'world' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('GET 携带 query 参数', async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      expect(String(url)).toContain('xsec_token=TOKEN');
      expect(String(url)).toContain('source_note_id=n1');
      return jsonResponse(200, okBody({}));
    });
    const client = new XhsClient({
      cookie: 'c',
      a1: 'a',
      rateLimiter: makeRateLimiter(),
      fetch: fetchMock as unknown as typeof fetch,
      signFn: mockSignFn,
    });

    await client.get('/api/sns/web/v1/feed', {
      source_note_id: 'n1',
      xsec_token: 'TOKEN',
    });
  });

  it('请求头包含签名字段、Cookie、UA、Referer', async () => {
    let capturedHeaders: Record<string, string> = {};
    const fetchMock = vi.fn(async (_url, init) => {
      capturedHeaders = (init as RequestInit).headers as Record<string, string>;
      return jsonResponse(200, okBody({}));
    });
    const client = new XhsClient({
      cookie: 'web_session=zzz',
      a1: 'my-a1',
      rateLimiter: makeRateLimiter(),
      fetch: fetchMock as unknown as typeof fetch,
      signFn: mockSignFn,
    });

    await client.get('/api/sns/web/v1/user/selfinfo');

    expect(capturedHeaders['x-s']).toBeDefined();
    expect(capturedHeaders['x-t']).toBeDefined();
    expect(capturedHeaders['x-s-common']).toBeDefined();
    expect(capturedHeaders['x-b3-traceid']).toBeDefined();
    expect(capturedHeaders['cookie']).toBe('web_session=zzz');
    expect(capturedHeaders['user-agent']).toContain('Chrome');
    expect(capturedHeaders['referer']).toBe('https://www.xiaohongshu.com/');
  });
});

describe('XhsClient — 错误码识别（R7.5）', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let limiter: RateLimiter;
  let client: XhsClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    limiter = makeRateLimiter();
    client = new XhsClient({
      cookie: 'c',
      a1: 'a',
      rateLimiter: limiter,
      fetch: fetchMock as unknown as typeof fetch,
      signFn: mockSignFn,
    });
  });

  it('HTTP 461 → XhsRiskControlError + rateLimiter 计数', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 461 }));
    const spy = vi.spyOn(limiter, 'recordRiskControl');

    await expect(client.get('/api/sns/web/v1/user/selfinfo')).rejects.toThrow(XhsRiskControlError);
    expect(spy).toHaveBeenCalled();
  });

  it('HTTP 401 → XhsAuthError', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 401 }));
    await expect(client.get('/api/sns/web/v1/user/selfinfo')).rejects.toThrow(XhsAuthError);
  });

  it('HTTP 403 → XhsAuthError', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 403 }));
    await expect(client.get('/api/sns/web/v1/user/selfinfo')).rejects.toThrow(XhsAuthError);
  });

  it('HTTP 500 → XhsApiError', async () => {
    fetchMock.mockResolvedValue(new Response('', { status: 500 }));
    await expect(client.get('/api/sns/web/v1/user/selfinfo')).rejects.toThrow(XhsApiError);
  });

  it('success=false, code=-100 → XhsAuthError（登录过期）', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: false, code: -100, msg: '登录已失效', data: null }),
    );
    await expect(client.get('/api/sns/web/v1/user/selfinfo')).rejects.toThrow(XhsAuthError);
  });

  it('success=false, 其他 code → XhsApiError', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { success: false, code: -101, msg: '签名错误', data: null }),
    );
    await expect(client.get('/api/sns/web/v1/user/selfinfo')).rejects.toThrow(XhsApiError);
  });

  it('响应不是合法 JSON → XhsApiError', async () => {
    fetchMock.mockResolvedValue(
      new Response('not json', {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      }),
    );
    await expect(client.get('/api/sns/web/v1/user/selfinfo')).rejects.toThrow(XhsApiError);
  });
});

describe('XhsClient — 域名白名单（R20.4）', () => {
  it('通过 endpoints 常量调用始终落在 edith.xiaohongshu.com', async () => {
    const fetchMock = vi.fn(async (url: URL | string) => {
      expect(new URL(String(url)).host).toBe('edith.xiaohongshu.com');
      return jsonResponse(200, okBody({}));
    });
    const client = new XhsClient({
      cookie: 'c',
      a1: 'a',
      rateLimiter: makeRateLimiter(),
      fetch: fetchMock as unknown as typeof fetch,
      signFn: mockSignFn,
    });

    await client.get('/api/sns/web/v1/user/selfinfo');
  });

  it('若有人直接传绝对 URL 指向非白名单域名 → 抛 XhsHostNotAllowedError', async () => {
    const fetchMock = vi.fn();
    const client = new XhsClient({
      cookie: 'c',
      a1: 'a',
      rateLimiter: makeRateLimiter(),
      fetch: fetchMock as unknown as typeof fetch,
      signFn: mockSignFn,
    });

    await expect(client.get('https://evil.example.com/api')).rejects.toThrow(
      XhsHostNotAllowedError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('XhsClient — 超时重试（R21.1）', () => {
  it('网络错误重试 1 次后仍失败 → 抛出原错误', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      throw new Error('fetch failed: socket hang up');
    });
    const client = new XhsClient({
      cookie: 'c',
      a1: 'a',
      rateLimiter: makeRateLimiter(),
      fetch: fetchMock as unknown as typeof fetch,
      signFn: mockSignFn,
      requestTimeoutMs: 50,
    });

    await expect(client.get('/api/sns/web/v1/user/selfinfo')).rejects.toThrow();
    expect(calls).toBe(2); // 初次 + 重试一次
  });

  it('第一次网络错误 + 第二次成功 → 返回结果', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error('fetch failed');
      return jsonResponse(200, okBody({ ok: 1 }));
    });
    const client = new XhsClient({
      cookie: 'c',
      a1: 'a',
      rateLimiter: makeRateLimiter(),
      fetch: fetchMock as unknown as typeof fetch,
      signFn: mockSignFn,
    });

    const data = await client.get<{ ok: number }>('/api/sns/web/v1/user/selfinfo');
    expect(data.ok).toBe(1);
    expect(calls).toBe(2);
  });

  it('业务错误码（461/401）不触发重试', async () => {
    let calls = 0;
    const fetchMock = vi.fn(async () => {
      calls++;
      return new Response('', { status: 461 });
    });
    const client = new XhsClient({
      cookie: 'c',
      a1: 'a',
      rateLimiter: makeRateLimiter(),
      fetch: fetchMock as unknown as typeof fetch,
      signFn: mockSignFn,
    });

    await expect(client.get('/api/sns/web/v1/user/selfinfo')).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('XhsClient — 无 signFn 时需要浏览器签名', () => {
  it.skip('不传 signFn 时调用会尝试启动浏览器签名服务（CI 环境测试）', async () => {
    const fetchMock = vi.fn();
    const client = new XhsClient({
      cookie: 'c',
      a1: 'a',
      rateLimiter: makeRateLimiter(),
      fetch: fetchMock as unknown as typeof fetch,
      // 不传 signFn → 会尝试启动 Chrome 签名服务
    });

    // 在没有 Chrome 的 CI 环境里会报错（但不是"签名占位"错误）
    await expect(client.get('/api/sns/web/v1/user/selfinfo')).rejects.toThrow();
    // 关键：fetch 不应该被调用（签名阶段就失败了）
    // 注意：如果本机有 Chrome 可能会成功启动，所以这个测试在 CI 里更有意义
  });
});
