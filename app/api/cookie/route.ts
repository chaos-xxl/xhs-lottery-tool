/**
 * POST /api/cookie — 导入 Cookie + 即时健康度自检
 * GET  /api/cookie — 查询当前 Cookie 状态（不返回原文）
 *
 * 对应 tasks.md Task 6.1；requirements.md R8 / R16.4。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '../../../lib/api/errors';
import { openSession, resetSessionCache } from '../../../lib/api/session';
import { SecureStore } from '../../../lib/config/secure-store';
import { XhsClient } from '../../../lib/xhs/client';
import { CookieMonitor } from '../../../lib/xhs/cookie-monitor';
import { RateLimiter } from '../../../lib/xhs/rate-limiter';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CookieImportSchema = z.object({
  /** 完整 Cookie 字符串（从浏览器 DevTools 复制的整段） */
  cookieString: z.string().min(50, 'Cookie 字符串过短，请从浏览器完整复制'),
});

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const { cookieString } = CookieImportSchema.parse(await req.json());

    // 从整段 Cookie 字符串中解析出必要字段
    const parsed = parseCookieFields(cookieString);
    if (!parsed.web_session || !parsed.a1 || !parsed.webId) {
      return NextResponse.json(
        {
          ok: false,
          code: 'invalid_cookie_shape',
          message: 'Cookie 中缺少必要字段（web_session / a1 / webId）',
        },
        { status: 400 },
      );
    }

    const store = new SecureStore();
    store.setCookie({
      web_session: parsed.web_session,
      a1: parsed.a1,
      webId: parsed.webId,
      _raw: cookieString,
    });
    resetSessionCache();

    // 立即探测一次
    const client = new XhsClient({
      cookie: cookieString,
      a1: parsed.a1,
      rateLimiter: new RateLimiter(),
    });
    const monitor = new CookieMonitor(client);
    const meta = await monitor.probe();

    if (meta.accountUserId) {
      store.updateValidationMeta({
        lastValidatedAt: Date.now(),
        accountUserId: meta.accountUserId,
      });
    }

    return NextResponse.json({
      ok: true,
      status: meta.status,
      accountUserId: meta.accountUserId,
      cooldownUntil: meta.cooldownUntil,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        {
          ok: false,
          code: 'invalid_cookie_shape',
          message: 'Cookie 字段不完整或格式错误',
          details: err.issues.map((i) => ({ path: i.path, message: i.message })),
        },
        { status: 400 },
      );
    }
    return errorResponse(err);
  }
}

/** 从整段 Cookie 字符串中提取关键字段 */
function parseCookieFields(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const pair of raw.split(';')) {
    const trimmed = pair.trim();
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    result[key] = value;
  }
  return result;
}

/**
 * 查询当前 Cookie 元信息（不返回 Cookie 原文）。
 */
export async function GET(): Promise<NextResponse> {
  try {
    const store = new SecureStore();
    if (!store.hasCookie()) {
      return NextResponse.json({
        ok: true,
        configured: false,
      });
    }
    const meta = store.getMeta();
    // 主动再 probe 一次以拿最新 status
    let status = 'unknown';
    let cooldownUntil = 0;
    try {
      const { monitor } = openSession();
      const result = await monitor.probe();
      status = result.status;
      cooldownUntil = result.cooldownUntil;
    } catch {
      // probe 失败也不影响 meta 返回
    }

    return NextResponse.json({
      ok: true,
      configured: true,
      status,
      cooldownUntil,
      accountUserId: meta?.accountUserId ?? null,
      createdAt: meta?.createdAt ?? null,
      lastValidatedAt: meta?.lastValidatedAt ?? null,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
