/**
 * API 层错误 → HTTP 响应的统一映射
 *
 * 所有 Route Handler 都用这个 helper 返回结构化错误，避免：
 *   - 泄漏堆栈给前端
 *   - Cookie 字段出现在响应体中
 *   - 错误码跨 route 不一致
 */

import { NextResponse } from 'next/server';
import { logger } from '../config/logger';
import { SecureStoreError } from '../config/secure-store';
import { InvalidDrawInputError, PoolInsufficientError } from '../lottery/draw';
import { EmptyConditionError } from '../lottery/filter';
import { AuthorGuardError } from '../xhs/author-guard';
import { XhsHostNotAllowedError } from '../xhs/client';
import { LinkParseError } from '../xhs/parse-url';
import { XhsApiError, XhsAuthError, XhsRiskControlError } from '../xhs/types';

export interface ApiError {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
  readonly hint?: string;
}

/**
 * 把错误映射为 (status, body)。
 *
 * - 已知的业务错误 → 4xx + 可展示文案
 * - 其它未知错误 → 500 + 泛化文案，真实堆栈只进日志
 */
export function errorResponse(err: unknown): NextResponse<ApiError> {
  // ---- 输入参数错误 ----
  if (err instanceof InvalidDrawInputError) {
    return NextResponse.json<ApiError>(
      { ok: false, code: err.code, message: err.message },
      { status: 400 },
    );
  }
  if (err instanceof EmptyConditionError) {
    return NextResponse.json<ApiError>(
      { ok: false, code: err.code, message: err.message },
      { status: 400 },
    );
  }
  if (err instanceof LinkParseError) {
    return NextResponse.json<ApiError>(
      { ok: false, code: err.code, message: err.message },
      { status: 400 },
    );
  }

  // ---- 自帖校验 / 安全阀 ----
  if (err instanceof AuthorGuardError) {
    return NextResponse.json<ApiError>(
      {
        ok: false,
        code: 'not_self_post',
        message: '这个工具只允许抓取你自己发布的帖子',
        hint: '请检查 Cookie 对应的账号是否就是这条帖子的发布账号',
      },
      { status: 403 },
    );
  }
  if (err instanceof XhsHostNotAllowedError) {
    return NextResponse.json<ApiError>(
      {
        ok: false,
        code: err.code,
        message: err.message,
      },
      { status: 400 },
    );
  }

  // ---- Cookie / 风控 ----
  if (err instanceof XhsAuthError) {
    return NextResponse.json<ApiError>(
      {
        ok: false,
        code: err.code,
        message: 'Cookie 已失效，请重新登录小红书获取',
        hint: '顶部徽标变红时点击即可进入 Cookie 配置页',
      },
      { status: 401 },
    );
  }
  if (err instanceof XhsRiskControlError) {
    return NextResponse.json<ApiError>(
      {
        ok: false,
        code: err.code,
        message: '触发小红书风控（461 滑块验证）',
        hint: '请等待 24 小时再试；期间请勿继续操作',
      },
      { status: 429 },
    );
  }
  if (err instanceof XhsApiError) {
    return NextResponse.json<ApiError>(
      {
        ok: false,
        code: err.code,
        message: `小红书接口返回错误 [${err.apiCode}]: ${err.apiMsg}`,
      },
      { status: 502 },
    );
  }

  // ---- 抽奖引擎 ----
  if (err instanceof PoolInsufficientError) {
    return NextResponse.json<ApiError>(
      {
        ok: false,
        code: err.code,
        message: err.message,
        hint: '请放宽过滤条件或降低抽奖人数',
      },
      { status: 422 },
    );
  }

  // ---- Secure Store ----
  if (err instanceof SecureStoreError) {
    const status =
      err.code === 'config_missing'
        ? 404
        : err.code === 'decrypt_failed' || err.code === 'schema_invalid'
          ? 400
          : 500;
    return NextResponse.json<ApiError>(
      { ok: false, code: err.code, message: err.message },
      { status },
    );
  }

  // ---- 未知 ----
  const message = err instanceof Error ? err.message : String(err);
  logger.error({ err: message }, 'API unhandled error');
  return NextResponse.json<ApiError>(
    {
      ok: false,
      code: 'internal_error',
      message: '服务器内部错误，请查看日志排查',
    },
    { status: 500 },
  );
}
