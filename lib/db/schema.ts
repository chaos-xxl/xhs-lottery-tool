/**
 * Drizzle ORM Schema for xhs-lottery-system
 *
 * 对应 design.md §1.3 数据模型 + requirements.md R6 / R7 / R11 / R12 / R13 / R15。
 *
 * 设计约束：
 *   - 单文件 SQLite，自用单用户，无并发写压力
 *   - 所有时间戳统一用 unix ms（integer）
 *   - 结构化字段（types / rules / candidate_ids / selected_ids / confirmed_ids）用 TEXT 存 JSON
 *   - win_history 用 (user_id, round_id) 复合主键保留完整审计（design 里单主键版本已被 tasks.md 更新）
 */

import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// ============================================================================
// Enums (SQLite 没有原生枚举，用字符串约束 + TS 层保证)
// ============================================================================

export type InteractionType = 'like' | 'collect' | 'follow' | 'comment';
export type DrawRoundStatus = 'drafted' | 'drawn' | 'confirmed';
export type LotteryRelation = 'AND' | 'OR';

/** 低质评分的过滤参数 */
export interface LotteryFilters {
  readonly minFollowsRatio?: number;
  readonly maxFollowsCount?: number;
  readonly lowQualityCommentThreshold?: number;
}

/** 抽奖规则快照（开奖时冻结，保证可复算） */
export interface LotteryRules {
  readonly conditions: readonly InteractionType[];
  readonly relation: LotteryRelation;
  readonly filters: LotteryFilters;
  /** 开奖时的 30 天黑名单快照（user_id 数组），对应 R12.1 */
  readonly blacklistAtDraw: readonly string[];
  /** 是否显式忽略 30 天黑名单，对应 R13.4 */
  readonly ignoreBlacklist: boolean;
}

// ============================================================================
// posts：每导入一个链接落一行，对应 R6.4
// ============================================================================

export const posts = sqliteTable('posts', {
  /** 小红书 note_id，从链接解析 */
  id: text('id').primaryKey(),
  /** xsec_token，调接口必需 */
  xsecToken: text('xsec_token').notNull(),
  xsecSource: text('xsec_source').notNull().default('pc_feed'),
  title: text('title').notNull().default(''),
  /** 帖子作者 user_id，用于自帖校验 Author_Guard */
  authorId: text('author_id').notNull(),
  authorName: text('author_name').notNull().default(''),
  /** 帖子发布时间 unix ms */
  createdAt: integer('created_at').notNull(),
  /** 导入本地时间 unix ms */
  importedAt: integer('imported_at').notNull().default(sql`(unixepoch() * 1000)`),
  /** 最近一次抓取互动的时间 unix ms；null 表示尚未抓取 */
  lastFetchedAt: integer('last_fetched_at'),
  rawUrl: text('raw_url').notNull(),
});

export type Post = typeof posts.$inferSelect;
export type NewPost = typeof posts.$inferInsert;

// ============================================================================
// interactions：一次抓取 = 一次快照；同帖多次抓取以最新为准（R7.6）
// ============================================================================

export const interactions = sqliteTable(
  'interactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    /** 小红书 user_id，稳定主键 */
    userId: text('user_id').notNull(),
    userNickname: text('user_nickname').notNull().default(''),
    userAvatar: text('user_avatar').notNull().default(''),
    /** 关注数（低质过滤用，部分帖子返回字段缺失时为 null） */
    userFollowsCount: integer('user_follows_count'),
    userFansCount: integer('user_fans_count'),
    /** 是否关注博主（R7.3，从 followed 字段直接读） */
    followedBlogger: integer('followed_blogger', { mode: 'boolean' }).notNull().default(false),
    /** types: InteractionType[] 的 JSON 字符串，例如 ["like","comment"] */
    types: text('types', { mode: 'json' }).$type<readonly InteractionType[]>().notNull(),
    commentText: text('comment_text'),
    commentCreatedAt: integer('comment_created_at'),
    fetchedAt: integer('fetched_at').notNull(),
  },
  (t) => ({
    // 每个帖子每个 user_id 只保留一条（UPSERT 以最新为准，R7.6）
    uniqPostUser: uniqueIndex('idx_interactions_post_user').on(t.postId, t.userId),
    byPost: index('idx_interactions_post').on(t.postId),
  }),
);

export type Interaction = typeof interactions.$inferSelect;
export type NewInteraction = typeof interactions.$inferInsert;

// ============================================================================
// draw_rounds：抽奖轮次，含规则快照 + seed + commit_hash + 三阶段 id 列表
// ============================================================================

export const drawRounds = sqliteTable(
  'draw_rounds',
  {
    /** UUID v4 */
    id: text('id').primaryKey(),
    postId: text('post_id')
      .notNull()
      .references(() => posts.id, { onDelete: 'cascade' }),
    prizeName: text('prize_name').notNull().default(''),
    winnerCount: integer('winner_count').notNull(),
    /** 规则快照（LotteryRules），开奖时冻结 */
    rules: text('rules', { mode: 'json' }).$type<LotteryRules>().notNull(),
    /** 32 字节 hex seed */
    seed: text('seed').notNull(),
    /** SHA-256(seed) hex */
    commitHash: text('commit_hash').notNull(),
    /** Candidate_Pool：经条件过滤 + 低质过滤 + 黑名单剔除后的有序 user_id[] JSON */
    candidateIds: text('candidate_ids', { mode: 'json' }).$type<readonly string[]>().notNull(),
    /** 算法选出的候选 user_id[] JSON */
    selectedIds: text('selected_ids', { mode: 'json' }).$type<readonly string[]>().notNull(),
    /** 用户手动确认入库的最终中奖 user_id[] JSON（未确认时为 []） */
    confirmedIds: text('confirmed_ids', { mode: 'json' })
      .$type<readonly string[]>()
      .notNull()
      .default(sql`'[]'`),
    /** 'drafted' | 'drawn' | 'confirmed' */
    status: text('status').$type<DrawRoundStatus>().notNull(),
    drawnAt: integer('drawn_at').notNull(),
    confirmedAt: integer('confirmed_at'),
    /** 补抽审计：[{ excluded: string[], newWinner: string, at: number }] JSON */
    redrawAudit: text('redraw_audit', { mode: 'json' })
      .$type<
        ReadonlyArray<{
          readonly excluded: readonly string[];
          readonly newWinner: string;
          readonly at: number;
        }>
      >()
      .notNull()
      .default(sql`'[]'`),
  },
  (t) => ({
    byPost: index('idx_rounds_post').on(t.postId),
    byConfirmedAt: index('idx_rounds_confirmed_at').on(t.confirmedAt),
  }),
);

export type DrawRound = typeof drawRounds.$inferSelect;
export type NewDrawRound = typeof drawRounds.$inferInsert;

// ============================================================================
// win_history：30 天去重的核心表（R13）
// ============================================================================

export const winHistory = sqliteTable(
  'win_history',
  {
    userId: text('user_id').notNull(),
    roundId: text('round_id')
      .notNull()
      .references(() => drawRounds.id, { onDelete: 'cascade' }),
    postId: text('post_id').notNull(),
    prizeName: text('prize_name'),
    /** unix ms */
    wonAt: integer('won_at').notNull(),
  },
  (t) => ({
    // 复合主键：保留同一用户历次中奖记录，30 天窗口由查询时间戳判断
    pk: primaryKey({ columns: [t.userId, t.roundId] }),
    byUserWonAt: index('idx_win_history_user_won_at').on(t.userId, t.wonAt),
    byWonAt: index('idx_win_history_won_at').on(t.wonAt),
  }),
);

export type WinHistoryRow = typeof winHistory.$inferSelect;
export type NewWinHistoryRow = typeof winHistory.$inferInsert;
