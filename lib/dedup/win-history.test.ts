/**
 * win-history 单元测试
 *
 * 验证（对应 R13 + R21.2）：
 *   - 30 天窗口边界：第 29、30、31 天
 *   - 同一 round_id 重复 commit → 只写入一次
 *   - 事务内某行失败 → 全部回滚
 *   - 不同用户 / 不同 round_id 允许多次写入
 *   - getWinHistoryForUsers 返回每个用户最新一次
 */

import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import {
  commitWinners,
  DAY_MS,
  DEFAULT_WINDOW_DAYS,
  getRecentWinners,
  getWinHistoryForUsers,
} from './win-history';

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'drizzle/migrations');
const NOW = 1_700_000_000_000;

let sqlite: ReturnType<typeof Database>;
let db: TestDb;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
});

afterEach(() => sqlite.close());

function seedRound(id: string): string {
  sqlite
    .prepare(
      `INSERT INTO posts (id, xsec_token, author_id, created_at, raw_url)
       VALUES ('post_1', 't', 'me', ?, 'u') ON CONFLICT DO NOTHING`,
    )
    .run(NOW);

  sqlite
    .prepare(
      `INSERT INTO draw_rounds
       (id, post_id, winner_count, rules, seed, commit_hash,
        candidate_ids, selected_ids, status, drawn_at)
       VALUES (?, 'post_1', 1, ?, ?, ?, '[]', '[]', 'drawn', ?)`,
    )
    .run(
      id,
      JSON.stringify({
        conditions: ['like'],
        relation: 'AND',
        filters: {},
        blacklistAtDraw: [],
        ignoreBlacklist: false,
      }),
      'a'.repeat(64),
      'b'.repeat(64),
      NOW,
    );

  return id;
}

// ============================================================================
// 30 天窗口边界
// ============================================================================

describe('getRecentWinners — 窗口边界', () => {
  it('第 29 天（窗口内）命中', () => {
    seedRound('r1');
    commitWinners(db, {
      roundId: 'r1',
      postId: 'post_1',
      userIds: ['u_day_29'],
      now: NOW - 29 * DAY_MS,
    });

    const result = getRecentWinners(db, { now: NOW });
    expect(result.has('u_day_29')).toBe(true);
  });

  it('正好 30 * DAY_MS 之前（左闭右开边界）命中', () => {
    seedRound('r1');
    // 恰好第 30 天 0 点写入，查询时 now 刚好是 won_at + 30 * DAY_MS
    commitWinners(db, {
      roundId: 'r1',
      postId: 'post_1',
      userIds: ['u_exact_30'],
      now: NOW - 30 * DAY_MS,
    });

    const result = getRecentWinners(db, { now: NOW });
    // 查询条件 won_at >= now - 30d，边界命中
    expect(result.has('u_exact_30')).toBe(true);
  });

  it('第 31 天（窗口外）不命中', () => {
    seedRound('r1');
    commitWinners(db, {
      roundId: 'r1',
      postId: 'post_1',
      userIds: ['u_day_31'],
      now: NOW - 31 * DAY_MS,
    });

    const result = getRecentWinners(db, { now: NOW });
    expect(result.has('u_day_31')).toBe(false);
  });

  it('自定义窗口 7 天', () => {
    seedRound('r1');
    commitWinners(db, {
      roundId: 'r1',
      postId: 'post_1',
      userIds: ['u_day_6', 'u_day_8'],
      now: NOW - 6 * DAY_MS,
    });
    commitWinners(db, {
      roundId: 'r1',
      postId: 'post_1',
      userIds: ['u_day_8_only'],
      now: NOW - 8 * DAY_MS,
    });

    const r = getRecentWinners(db, { now: NOW, windowDays: 7 });
    expect(r.has('u_day_6')).toBe(true);
    expect(r.has('u_day_8_only')).toBe(false);
  });

  it('默认窗口是 30 天', () => {
    expect(DEFAULT_WINDOW_DAYS).toBe(30);
  });
});

// ============================================================================
// commitWinners 幂等性
// ============================================================================

describe('commitWinners — 幂等性与事务', () => {
  it('同一 (user_id, round_id) 重复 commit 只写入一次', () => {
    seedRound('r1');

    commitWinners(db, {
      roundId: 'r1',
      postId: 'post_1',
      userIds: ['u_alpha'],
      now: NOW,
    });
    commitWinners(db, {
      roundId: 'r1',
      postId: 'post_1',
      userIds: ['u_alpha'],
      now: NOW + 500, // 不同时间戳也应该被吸收
    });

    const count = (
      sqlite.prepare('SELECT COUNT(*) as c FROM win_history WHERE user_id = ?').get('u_alpha') as {
        c: number;
      }
    ).c;
    expect(count).toBe(1);
  });

  it('同一用户不同 round_id 允许多次中奖（保留完整审计）', () => {
    seedRound('r1');
    seedRound('r2');

    commitWinners(db, {
      roundId: 'r1',
      postId: 'post_1',
      userIds: ['u_multi'],
      now: NOW - 60 * DAY_MS, // 很久以前
    });
    commitWinners(db, {
      roundId: 'r2',
      postId: 'post_1',
      userIds: ['u_multi'],
      now: NOW,
    });

    const count = (
      sqlite.prepare('SELECT COUNT(*) as c FROM win_history WHERE user_id = ?').get('u_multi') as {
        c: number;
      }
    ).c;
    expect(count).toBe(2);
  });

  it('空 userIds → 不崩溃、不写入', () => {
    seedRound('r1');
    expect(() =>
      commitWinners(db, { roundId: 'r1', postId: 'post_1', userIds: [], now: NOW }),
    ).not.toThrow();

    const count = (sqlite.prepare('SELECT COUNT(*) as c FROM win_history').get() as { c: number })
      .c;
    expect(count).toBe(0);
  });

  it('外键约束失败（round_id 不存在）→ 事务回滚，无部分写入（R21.2）', () => {
    // 没 seedRound，直接 commit 一个 round_id 不存在的情况
    expect(() =>
      commitWinners(db, {
        roundId: 'nonexistent_round',
        postId: 'post_ghost',
        userIds: ['u_a', 'u_b', 'u_c'],
        now: NOW,
      }),
    ).toThrow(/FOREIGN KEY/);

    const count = (sqlite.prepare('SELECT COUNT(*) as c FROM win_history').get() as { c: number })
      .c;
    expect(count).toBe(0);
  });
});

// ============================================================================
// getWinHistoryForUsers
// ============================================================================

describe('getWinHistoryForUsers — 按 user_id 批量查历史', () => {
  it('返回每个用户窗口内最新一次中奖记录', () => {
    seedRound('r1');
    seedRound('r2');

    commitWinners(db, {
      roundId: 'r1',
      postId: 'post_1',
      prizeName: 'prize_1',
      userIds: ['u_alpha'],
      now: NOW - 10 * DAY_MS,
    });
    commitWinners(db, {
      roundId: 'r2',
      postId: 'post_1',
      prizeName: 'prize_2',
      userIds: ['u_alpha'],
      now: NOW - 3 * DAY_MS,
    });

    const map = getWinHistoryForUsers(db, {
      userIds: ['u_alpha', 'u_never_won'],
      now: NOW,
    });

    expect(map.get('u_alpha')?.lastWonAt).toBe(NOW - 3 * DAY_MS);
    expect(map.get('u_alpha')?.prizeName).toBe('prize_2');
    expect(map.has('u_never_won')).toBe(false);
  });

  it('空 userIds → 空 Map', () => {
    const map = getWinHistoryForUsers(db, { userIds: [], now: NOW });
    expect(map.size).toBe(0);
  });

  it('用户历史都在窗口外 → 不返回', () => {
    seedRound('r1');
    commitWinners(db, {
      roundId: 'r1',
      postId: 'post_1',
      userIds: ['u_ancient'],
      now: NOW - 100 * DAY_MS,
    });

    const map = getWinHistoryForUsers(db, {
      userIds: ['u_ancient'],
      now: NOW,
      windowDays: 30,
    });
    expect(map.size).toBe(0);
  });
});
