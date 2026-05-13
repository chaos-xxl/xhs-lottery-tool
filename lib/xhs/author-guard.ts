/**
 * 自帖校验（Author Guard）
 *
 * 对应 requirements.md R1（自帖校验护栏，最高优先级）、R5.2（仅对 Author_Guard 通过的帖子抓取）。
 *
 * 强制规则：
 *   - 所有业务入口（抓取、开奖、补抽）必须先经过 ensureSelfPost 返回 ok=true 才能继续
 *   - 作者 user_id !== 当前登录账号 user_id → 立即拒绝，不可绕过
 *   - 接口 401/461 → 向上传播对应错误，不允许「模糊通过」
 *   - 每次校验都写一条审计日志
 */

import { logger } from '../config/logger';
import { ENDPOINTS } from './endpoints';
import {
  type NoteFeedResponse,
  XhsAuthError,
  type XhsClientLike,
  XhsRiskControlError,
} from './types';

// ============================================================================
// Types
// ============================================================================

export type AuthorGuardReason =
  | 'not_self_post'
  | 'cookie_expired'
  | 'risk_control_triggered'
  | 'fetch_failed';

export type AuthorGuardResult =
  | {
      readonly ok: true;
      readonly authorId: string;
      readonly noteId: string;
      readonly noteTitle: string;
      readonly publishedAt: number;
    }
  | {
      readonly ok: false;
      readonly reason: AuthorGuardReason;
      readonly message: string;
      /** 401/461 情形会带原始错误，上层可继续透传 */
      readonly error?: Error;
    };

export interface EnsureSelfPostInput {
  readonly noteId: string;
  readonly xsecToken: string;
  readonly currentUserId: string;
  readonly xsecSource?: string;
}

export class AuthorGuardError extends Error {
  readonly code = 'not_self_post' as const;

  constructor(
    readonly currentUserId: string,
    readonly authorId: string,
    readonly noteId: string,
  ) {
    super(`自帖校验失败：当前账号 ${currentUserId} 不是帖子 ${noteId} 的作者（作者 ${authorId}）`);
    this.name = 'AuthorGuardError';
  }
}

// ============================================================================
// Implementation
// ============================================================================

/**
 * 校验某个帖子是否属于当前登录账号。
 *
 * 接口：笔记详情 /api/sns/web/v1/feed，解析 note.user.user_id。
 * 成功返回 ok + 元信息；失败返回结构化 reason 供上层做 UI 处理。
 *
 * 为什么返回「结果对象」而不是直接抛：上层（API Route）通常需要把 not_self_post
 * 映射成 HTTP 403、把 risk_control 映射成 409，结构化返回值更方便。
 * 但为了「不可绕过」，额外提供 ensureSelfPostOrThrow() 强制抛出版本。
 */
export async function ensureSelfPost(
  client: XhsClientLike,
  input: EnsureSelfPostInput,
): Promise<AuthorGuardResult> {
  const { noteId, xsecToken, currentUserId, xsecSource = 'pc_feed' } = input;
  const auditBase = {
    ts: Date.now(),
    action: 'author_guard',
    currentUserId,
    noteId,
  };

  let feed: NoteFeedResponse;
  try {
    feed = await client.get<NoteFeedResponse>(ENDPOINTS.noteFeed, {
      source_note_id: noteId,
      xsec_token: xsecToken,
      xsec_source: xsecSource,
    });
  } catch (err) {
    if (err instanceof XhsAuthError) {
      logger.warn({ ...auditBase, result: 'cookie_expired' }, 'Author Guard 拒绝：Cookie 失效');
      return {
        ok: false,
        reason: 'cookie_expired',
        message: err.message,
        error: err,
      };
    }
    if (err instanceof XhsRiskControlError) {
      logger.warn(
        { ...auditBase, result: 'risk_control_triggered' },
        'Author Guard 拒绝：触发 461 风控',
      );
      return {
        ok: false,
        reason: 'risk_control_triggered',
        message: err.message,
        error: err,
      };
    }
    logger.error(
      { ...auditBase, result: 'fetch_failed', err: (err as Error).message },
      'Author Guard 拒绝：笔记详情接口调用失败',
    );
    return {
      ok: false,
      reason: 'fetch_failed',
      message: `笔记详情接口调用失败：${(err as Error).message}`,
      error: err as Error,
    };
  }

  const authorId = feed?.note?.user?.user_id;
  if (typeof authorId !== 'string' || authorId.length === 0) {
    logger.error(
      { ...auditBase, result: 'fetch_failed' },
      'Author Guard 拒绝：响应缺少作者 user_id',
    );
    return {
      ok: false,
      reason: 'fetch_failed',
      message: '笔记详情响应结构异常：缺少作者 user_id',
    };
  }

  if (authorId !== currentUserId) {
    logger.warn(
      { ...auditBase, result: 'not_self_post', authorId },
      `Author Guard 拒绝：帖子作者 ${authorId} 与当前账号 ${currentUserId} 不一致`,
    );
    return {
      ok: false,
      reason: 'not_self_post',
      message: '这个工具只允许抓取你自己发布的帖子',
    };
  }

  logger.info({ ...auditBase, result: 'ok', authorId }, 'Author Guard 通过：帖子属于当前登录账号');

  return {
    ok: true,
    authorId,
    noteId: feed.note.id,
    noteTitle: feed.note.title,
    publishedAt: feed.note.time,
  };
}

/**
 * 强制抛出版：Author Guard 失败时抛 AuthorGuardError 或原始 XhsAuth/RiskControl 错误。
 *
 * 用于「不可绕过」的调用点（如 fetchInteractions 开头）。
 */
export async function ensureSelfPostOrThrow(
  client: XhsClientLike,
  input: EnsureSelfPostInput,
): Promise<Extract<AuthorGuardResult, { ok: true }>> {
  const result = await ensureSelfPost(client, input);
  if (result.ok) return result;

  if (result.reason === 'not_self_post') {
    // 我们暂时不知道真实 authorId（result 里没暴露），用占位
    throw new AuthorGuardError(input.currentUserId, 'unknown', input.noteId);
  }
  if (result.error) throw result.error;
  throw new Error(result.message);
}
