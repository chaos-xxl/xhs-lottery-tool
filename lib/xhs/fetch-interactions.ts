/**
 * 互动用户抓取器
 *
 * 对应 requirements.md R7（互动用户抓取）、R3.3（1000 条上限）、R3.5（禁用粉丝列表）。
 *
 * 设计：
 *   - 按用户选择的条件（like/collect/follow/comment）分别调对应接口
 *   - 结果按 user_id 归一合并（mergeUser）
 *   - 评论含二级评论展开
 *   - 关注用 followed 字段间接判定，不反向拉粉丝列表
 *   - 401/461 立即停止，保留已抓部分
 *   - 单次累计达 1000 条由 rate-limiter 信号中断翻页
 */

import { logger } from '../config/logger';
import { ENDPOINTS } from './endpoints';
import type { RateLimiter } from './rate-limiter';
import type { XhsClientLike } from './types';
import { XhsAuthError, XhsRiskControlError } from './types';

// ============================================================================
// Types
// ============================================================================

export type InteractionKind = 'like' | 'collect' | 'follow' | 'comment';

export interface InteractionRecord {
  readonly userId: string;
  readonly userNickname: string;
  readonly userAvatar: string;
  /** 是否关注博主（R7.3） */
  readonly followedBlogger: boolean;
  /** 命中的互动类型集合 */
  types: readonly InteractionKind[];
  /** 评论文本：只在 types 含 'comment' 时填 */
  readonly commentText?: string;
  /** 评论发布时间 unix ms */
  readonly commentCreatedAt?: number;
  /** 用户维度扩展字段（低质评分用）—— 某些接口不返回时为 undefined */
  readonly userFollowsCount?: number;
  readonly userFansCount?: number;
}

export interface FetchTarget {
  readonly noteId: string;
  readonly xsecToken: string;
  readonly xsecSource?: string;
}

export interface FetchInteractionsResult {
  readonly users: ReadonlyMap<string, InteractionRecord>;
  readonly fetchedAt: number;
  /** 抓取过程中遇到的中断原因（若有） */
  readonly abortReason?: 'auth_error' | 'risk_control' | 'pool_cap' | 'unknown';
  /** 中断时的部分结果条数（仅 abortReason 非空时有意义） */
  readonly partial?: boolean;
}

// ============================================================================
// Endpoint response contracts（各接口最小必要字段）
// ============================================================================

interface CommentUser {
  readonly user_id: string;
  readonly nickname: string;
  readonly image: string;
  readonly followed?: boolean;
}

interface CommentItem {
  readonly id: string;
  readonly content: string;
  readonly create_time: number;
  readonly user_info: CommentUser;
  readonly sub_comments?: CommentItem[];
}

interface CommentPageResponse {
  readonly comments: readonly CommentItem[];
  readonly cursor: string;
  readonly has_more: boolean;
}

interface LikedUserItem {
  readonly user_id: string;
  readonly nickname: string;
  readonly image: string;
  readonly followed?: boolean;
  readonly follows?: number;
  readonly fans?: number;
}

interface LikedPageResponse {
  readonly users: readonly LikedUserItem[];
  readonly cursor: string;
  readonly has_more: boolean;
}

type CollectedPageResponse = LikedPageResponse; // 字段相同

// ============================================================================
// Public API
// ============================================================================

export async function fetchInteractions(
  client: XhsClientLike,
  rateLimiter: RateLimiter,
  target: FetchTarget,
  conditions: readonly InteractionKind[],
): Promise<FetchInteractionsResult> {
  const users = new Map<string, InteractionRecord>();
  rateLimiter.resetSession();

  let abortReason: FetchInteractionsResult['abortReason'];
  const start = Date.now();

  try {
    if (conditions.includes('comment')) {
      await fetchComments(client, rateLimiter, target, users);
      if (rateLimiter.shouldStopForSessionCap()) throw new PoolCapReached();
    }
    if (conditions.includes('like')) {
      await fetchLikes(client, rateLimiter, target, users);
      if (rateLimiter.shouldStopForSessionCap()) throw new PoolCapReached();
    }
    if (conditions.includes('collect')) {
      await fetchCollects(client, rateLimiter, target, users);
      if (rateLimiter.shouldStopForSessionCap()) throw new PoolCapReached();
    }
    // follow：不单独调接口，由 mergeUser 读 followed 字段
  } catch (err) {
    abortReason = mapAbortReason(err);
    logger.warn(
      { noteId: target.noteId, reason: abortReason, collected: users.size },
      '抓取中断，保留已抓部分',
    );
  }

  return {
    users,
    fetchedAt: start,
    ...(abortReason ? { abortReason, partial: true } : {}),
  };
}

/** mergeUser 纯函数导出，供测试使用 */
export function mergeUser(
  map: Map<string, InteractionRecord>,
  incoming: Partial<InteractionRecord> & { userId: string },
): void {
  const existing = map.get(incoming.userId);
  if (!existing) {
    map.set(incoming.userId, {
      userId: incoming.userId,
      userNickname: incoming.userNickname ?? '',
      userAvatar: incoming.userAvatar ?? '',
      followedBlogger: incoming.followedBlogger ?? false,
      types: incoming.types ?? [],
      ...(incoming.commentText !== undefined ? { commentText: incoming.commentText } : {}),
      ...(incoming.commentCreatedAt !== undefined
        ? { commentCreatedAt: incoming.commentCreatedAt }
        : {}),
      ...(incoming.userFollowsCount !== undefined
        ? { userFollowsCount: incoming.userFollowsCount }
        : {}),
      ...(incoming.userFansCount !== undefined ? { userFansCount: incoming.userFansCount } : {}),
    });
    return;
  }

  // 合并 types（去重保序）
  const merged = new Set([...existing.types, ...(incoming.types ?? [])]);
  existing.types = Array.from(merged);

  // followed 只要任一来源为 true 就保留 true
  if (incoming.followedBlogger) {
    (existing as { followedBlogger: boolean }).followedBlogger = true;
  }

  // 首个 comment_text 优先保留
  if (!existing.commentText && incoming.commentText) {
    (existing as { commentText?: string }).commentText = incoming.commentText;
    (existing as { commentCreatedAt?: number }).commentCreatedAt = incoming.commentCreatedAt;
  }

  // 扩展字段：有就补
  if (existing.userFollowsCount === undefined && incoming.userFollowsCount !== undefined) {
    (existing as { userFollowsCount?: number }).userFollowsCount = incoming.userFollowsCount;
  }
  if (existing.userFansCount === undefined && incoming.userFansCount !== undefined) {
    (existing as { userFansCount?: number }).userFansCount = incoming.userFansCount;
  }
}

// ============================================================================
// Internals
// ============================================================================

class PoolCapReached extends Error {
  constructor() {
    super('单会话抓取上限已到');
    this.name = 'PoolCapReached';
  }
}

function mapAbortReason(err: unknown): FetchInteractionsResult['abortReason'] {
  if (err instanceof XhsAuthError) return 'auth_error';
  if (err instanceof XhsRiskControlError) return 'risk_control';
  if (err instanceof PoolCapReached) return 'pool_cap';
  return 'unknown';
}

async function fetchComments(
  client: XhsClientLike,
  rateLimiter: RateLimiter,
  target: FetchTarget,
  users: Map<string, InteractionRecord>,
): Promise<void> {
  let cursor = '';
  do {
    if (rateLimiter.shouldStopForSessionCap()) throw new PoolCapReached();

    const page = await client.get<CommentPageResponse>(ENDPOINTS.commentPage, {
      note_id: target.noteId,
      cursor,
      top_comment_id: '',
      image_formats: 'jpg,webp,avif',
      xsec_token: target.xsecToken,
      xsec_source: target.xsecSource ?? 'pc_feed',
    });

    for (const c of page.comments) {
      mergeUser(users, {
        userId: c.user_info.user_id,
        userNickname: c.user_info.nickname,
        userAvatar: c.user_info.image,
        followedBlogger: c.user_info.followed ?? false,
        types: ['comment'],
        commentText: c.content,
        commentCreatedAt: c.create_time,
      });
      rateLimiter.addToSession(1);

      // 二级评论（楼中楼）
      for (const sub of c.sub_comments ?? []) {
        mergeUser(users, {
          userId: sub.user_info.user_id,
          userNickname: sub.user_info.nickname,
          userAvatar: sub.user_info.image,
          followedBlogger: sub.user_info.followed ?? false,
          types: ['comment'],
          commentText: sub.content,
          commentCreatedAt: sub.create_time,
        });
        rateLimiter.addToSession(1);
      }
    }

    cursor = page.has_more && page.cursor ? page.cursor : '';
  } while (cursor);
}

async function fetchLikes(
  client: XhsClientLike,
  rateLimiter: RateLimiter,
  target: FetchTarget,
  users: Map<string, InteractionRecord>,
): Promise<void> {
  let cursor = '';
  do {
    if (rateLimiter.shouldStopForSessionCap()) throw new PoolCapReached();

    const page = await client.get<LikedPageResponse>(ENDPOINTS.notesLiked, {
      note_id: target.noteId,
      cursor,
      xsec_token: target.xsecToken,
      xsec_source: target.xsecSource ?? 'pc_feed',
    });

    for (const u of page.users) {
      mergeUser(users, {
        userId: u.user_id,
        userNickname: u.nickname,
        userAvatar: u.image,
        followedBlogger: u.followed ?? false,
        types: ['like'],
        ...(u.follows !== undefined ? { userFollowsCount: u.follows } : {}),
        ...(u.fans !== undefined ? { userFansCount: u.fans } : {}),
      });
      rateLimiter.addToSession(1);
    }

    cursor = page.has_more && page.cursor ? page.cursor : '';
  } while (cursor);
}

async function fetchCollects(
  client: XhsClientLike,
  rateLimiter: RateLimiter,
  target: FetchTarget,
  users: Map<string, InteractionRecord>,
): Promise<void> {
  let cursor = '';
  do {
    if (rateLimiter.shouldStopForSessionCap()) throw new PoolCapReached();

    const page = await client.get<CollectedPageResponse>(ENDPOINTS.notesCollected, {
      note_id: target.noteId,
      cursor,
      xsec_token: target.xsecToken,
      xsec_source: target.xsecSource ?? 'pc_feed',
    });

    for (const u of page.users) {
      mergeUser(users, {
        userId: u.user_id,
        userNickname: u.nickname,
        userAvatar: u.image,
        followedBlogger: u.followed ?? false,
        types: ['collect'],
        ...(u.follows !== undefined ? { userFollowsCount: u.follows } : {}),
        ...(u.fans !== undefined ? { userFansCount: u.fans } : {}),
      });
      rateLimiter.addToSession(1);
    }

    cursor = page.has_more && page.cursor ? page.cursor : '';
  } while (cursor);
}
