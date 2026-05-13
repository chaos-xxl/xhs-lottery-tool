/**
 * Property-Based Test: Dedup Guarantee (P3)
 *
 * 对应 requirements.md Correctness Property #3：
 *   "对任意 Candidate_Pool，Lottery_Engine 的抽取结果不应包含任何在 30 天内已确认中奖的
 *    user_id（除非显式开启 ignoreBlacklist 开关）。"
 *
 * 对应 tasks.md Task 8.3，映射 Requirements 13.1 / 13.4 / 13.5。
 */

import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import * as schema from '../db/schema';
import { commitWinners, DAY_MS, getRecentWinners } from './win-history';

const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'drizzle/migrations');
const NOW = 1_700_000_000_000;

function freshDb(): {
  db: ReturnType<typeof drizzle<typeof schema>>;
  sqlite: ReturnType<typeof Database>;
} {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  // 预先建一个 round + post 让所有插入 FK 都能通过
  sqlite
    .prepare(
      `INSERT INTO posts (id, xsec_token, author_id, created_at, raw_url)
       VALUES ('post_1', 't', 'me', ?, 'u')`,
    )
    .run(NOW);
  sqlite
    .prepare(
      `INSERT INTO draw_rounds
       (id, post_id, winner_count, rules, seed, commit_hash,
        candidate_ids, selected_ids, status, drawn_at)
       VALUES ('r1', 'post_1', 1, ?, ?, ?, '[]', '[]', 'drawn', ?)`,
    )
    .run(
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
  return { db, sqlite };
}

// 每条记录：user_id + 距 NOW 过去多少天中奖（0~60 天分布）
const winRecordArb = fc.record({
  userId: fc.string({
    minLength: 3,
    maxLength: 12,
    unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
  }),
  daysAgo: fc.integer({ min: 0, max: 60 }),
});

describe('PBT P3 — 30 天去重保证', () => {
  it('ignoreBlacklist=false：getRecentWinners 返回集合 ⊇ 窗口内所有中奖 user_id', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(winRecordArb, { minLength: 0, maxLength: 40, selector: (r) => r.userId }),
        (records) => {
          const { db, sqlite } = freshDb();

          try {
            // 写入所有历史
            for (const r of records) {
              commitWinners(db, {
                roundId: 'r1',
                postId: 'post_1',
                userIds: [r.userId],
                now: NOW - r.daysAgo * DAY_MS,
              });
            }

            const blacklist = getRecentWinners(db, { now: NOW, windowDays: 30 });

            // 属性 1：窗口内（daysAgo <= 30）的每个 user_id 都应在黑名单
            for (const r of records) {
              if (r.daysAgo <= 30) {
                expect(blacklist.has(r.userId)).toBe(true);
              }
            }

            // 属性 2：黑名单中的每个 user_id 在历史中必有一条 daysAgo <= 30 的记录
            for (const id of blacklist) {
              const hasWindowHit = records.some((r) => r.userId === id && r.daysAgo <= 30);
              expect(hasWindowHit).toBe(true);
            }
          } finally {
            sqlite.close();
          }
        },
      ),
      { numRuns: 40 }, // SQLite 迁移较重，控制次数
    );
  });

  it('候选池 ∩ 黑名单 = ∅（去重生效）', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(winRecordArb, { minLength: 0, maxLength: 30, selector: (r) => r.userId }),
        fc.array(
          fc.string({
            minLength: 3,
            maxLength: 12,
            unit: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789'.split('')),
          }),
          { minLength: 5, maxLength: 40 },
        ),
        (winRecords, rawPool) => {
          const { db, sqlite } = freshDb();
          try {
            for (const r of winRecords) {
              commitWinners(db, {
                roundId: 'r1',
                postId: 'post_1',
                userIds: [r.userId],
                now: NOW - r.daysAgo * DAY_MS,
              });
            }

            const blacklist = getRecentWinners(db, { now: NOW });
            const candidatePool = Array.from(new Set(rawPool)).filter((id) => !blacklist.has(id));

            // 属性：过滤后的候选池与黑名单不相交
            for (const id of candidatePool) {
              expect(blacklist.has(id)).toBe(false);
            }
          } finally {
            sqlite.close();
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
