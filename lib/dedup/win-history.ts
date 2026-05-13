/**
 * 30 天中奖去重管理
 *
 * 对应 requirements.md R13（30 天内中奖去重）、R12.1（规则快照含黑名单）、
 * R21.2（事务原子性）、R15.4（永久保留审计）。
 *
 * 设计约束：
 *   - 左闭右开窗口：`won_at >= now - 30 * 86_400_000`
 *   - 复合主键 (user_id, round_id) 保留完整审计（同一用户多轮次中奖均可落库）
 *   - 单事务写入所有确认中奖者，任何一行失败全回滚
 *   - 支持 `ignoreBlacklist` 开关显式跳过黑名单查询
 */

import { and, gte, inArray, sql } from 'drizzle-orm';
import type { AppDatabase } from '../db';
import { winHistory } from '../db/schema';

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_WINDOW_DAYS = 30;
export const DAY_MS = 86_400_000;

// ============================================================================
// Types
// ============================================================================

export interface GetRecentWinnersInput {
  readonly windowDays?: number;
  readonly now?: number;
}

export interface CommitWinnersInput {
  readonly roundId: string;
  readonly postId: string;
  readonly prizeName?: string;
  readonly userIds: readonly string[];
  readonly now?: number;
}

export interface GetWinHistoryForUsersInput {
  readonly userIds: readonly string[];
  readonly windowDays?: number;
  readonly now?: number;
}

export interface UserWinRecord {
  readonly userId: string;
  readonly lastWonAt: number;
  readonly prizeName: string | null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * 获取 windowDays 内中过奖的 user_id 集合（黑名单）。
 *
 * 窗口约定：`won_at >= now - windowDays * 86_400_000`（左闭右开）
 */
export function getRecentWinners(db: AppDatabase, input: GetRecentWinnersInput = {}): Set<string> {
  const now = input.now ?? Date.now();
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
  const threshold = now - windowDays * DAY_MS;

  const rows = db
    .select({ userId: winHistory.userId })
    .from(winHistory)
    .where(gte(winHistory.wonAt, threshold))
    .groupBy(winHistory.userId)
    .all();

  return new Set(rows.map((r) => r.userId));
}

/**
 * 在单事务内把一轮次的确认中奖者一并写入 win_history。
 *
 * 语义：
 *   - 重复 (user_id, round_id) 通过 ON CONFLICT DO NOTHING 吸收（R13.2 的幂等性）
 *   - 事务失败 → 全部回滚（R21.2）
 */
export function commitWinners(db: AppDatabase, input: CommitWinnersInput): void {
  if (input.userIds.length === 0) return;

  const now = input.now ?? Date.now();

  db.transaction((tx) => {
    for (const userId of input.userIds) {
      tx.insert(winHistory)
        .values({
          userId,
          roundId: input.roundId,
          postId: input.postId,
          prizeName: input.prizeName ?? null,
          wonAt: now,
        })
        .onConflictDoNothing({
          target: [winHistory.userId, winHistory.roundId],
        })
        .run();
    }
  });
}

/**
 * 查指定一组 user_id 在窗口内是否有中奖记录（UI 展示「该用户近期曾中奖」徽标用）。
 */
export function getWinHistoryForUsers(
  db: AppDatabase,
  input: GetWinHistoryForUsersInput,
): Map<string, UserWinRecord> {
  if (input.userIds.length === 0) return new Map();

  const now = input.now ?? Date.now();
  const windowDays = input.windowDays ?? DEFAULT_WINDOW_DAYS;
  const threshold = now - windowDays * DAY_MS;

  const rows = db
    .select({
      userId: winHistory.userId,
      wonAt: winHistory.wonAt,
      prizeName: winHistory.prizeName,
    })
    .from(winHistory)
    .where(and(inArray(winHistory.userId, [...input.userIds]), gte(winHistory.wonAt, threshold)))
    .orderBy(sql`${winHistory.wonAt} DESC`)
    .all();

  const result = new Map<string, UserWinRecord>();
  for (const r of rows) {
    // 只保留每个用户最新一次
    if (!result.has(r.userId)) {
      result.set(r.userId, {
        userId: r.userId,
        lastWonAt: r.wonAt,
        prizeName: r.prizeName,
      });
    }
  }
  return result;
}
