/**
 * Schema / 迁移 / 约束 单元测试
 *
 * 策略：用 in-memory SQLite，每个测试独立跑一次迁移，验证：
 *   - 所有表、索引、主键存在
 *   - win_history 复合主键约束生效（ON CONFLICT DO NOTHING 语义）
 *   - interactions (post_id, user_id) UNIQUE 约束生效
 *   - 外键级联删除（删 post 会连带删 interactions / draw_rounds）
 */

import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as schema from './schema';

type TestDb = ReturnType<typeof drizzle<typeof schema>>;

const MIGRATIONS_FOLDER = path.resolve(process.cwd(), 'drizzle/migrations');

let sqlite: ReturnType<typeof Database>;
let db: TestDb;

beforeEach(() => {
  sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
});

afterEach(() => {
  sqlite.close();
});

// ============================================================================
// 表结构存在性断言
// ============================================================================

describe('迁移 — 表与索引存在性', () => {
  function listTables(): string[] {
    return (
      sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((r) => r.name);
  }

  function listIndexes(table: string): string[] {
    return (
      sqlite.prepare(`PRAGMA index_list(${table})`).all() as Array<{
        name: string;
        unique: number;
      }>
    ).map((r) => r.name);
  }

  function isUnique(table: string, index: string): boolean {
    const rows = sqlite.prepare(`PRAGMA index_list(${table})`).all() as Array<{
      name: string;
      unique: number;
    }>;
    return rows.find((r) => r.name === index)?.unique === 1;
  }

  it('四张核心表都被创建', () => {
    const tables = listTables();
    expect(tables).toContain('posts');
    expect(tables).toContain('interactions');
    expect(tables).toContain('draw_rounds');
    expect(tables).toContain('win_history');
  });

  it('win_history 的两个窗口查询索引都存在', () => {
    const idxs = listIndexes('win_history');
    expect(idxs).toContain('idx_win_history_user_won_at');
    expect(idxs).toContain('idx_win_history_won_at');
  });

  it('interactions 的 (post_id, user_id) 索引是 UNIQUE', () => {
    expect(isUnique('interactions', 'idx_interactions_post_user')).toBe(true);
  });

  it('draw_rounds 的辅助索引都存在', () => {
    const idxs = listIndexes('draw_rounds');
    expect(idxs).toContain('idx_rounds_post');
    expect(idxs).toContain('idx_rounds_confirmed_at');
  });
});

// ============================================================================
// win_history 复合主键：同 (user_id, round_id) 重复插入应被 ON CONFLICT 吸收
// ============================================================================

describe('win_history — 复合主键与 ON CONFLICT DO NOTHING', () => {
  function seedPostAndRound(): { postId: string; roundId: string } {
    const postId = 'note_test_001';
    const roundId = 'round_test_001';

    sqlite
      .prepare(
        `INSERT INTO posts (id, xsec_token, author_id, created_at, raw_url)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(postId, 'tok', 'me', Date.now(), 'https://x.test/');

    sqlite
      .prepare(
        `INSERT INTO draw_rounds
         (id, post_id, winner_count, rules, seed, commit_hash,
          candidate_ids, selected_ids, status, drawn_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        roundId,
        postId,
        1,
        JSON.stringify({
          conditions: ['like'],
          relation: 'AND',
          filters: {},
          blacklistAtDraw: [],
          ignoreBlacklist: false,
        }),
        'a'.repeat(64),
        'b'.repeat(64),
        JSON.stringify(['u1']),
        JSON.stringify(['u1']),
        'drawn',
        Date.now(),
      );

    return { postId, roundId };
  }

  it('相同 (user_id, round_id) 二次插入在 ON CONFLICT DO NOTHING 下不抛错', () => {
    const { postId, roundId } = seedPostAndRound();
    const now = Date.now();

    const insert = sqlite.prepare(
      `INSERT INTO win_history (user_id, round_id, post_id, prize_name, won_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, round_id) DO NOTHING`,
    );

    const first = insert.run('user_alpha', roundId, postId, 'prize', now);
    expect(first.changes).toBe(1);

    const second = insert.run('user_alpha', roundId, postId, 'prize', now + 1);
    expect(second.changes).toBe(0); // 复合主键冲突，吸收

    const count = (sqlite.prepare('SELECT COUNT(*) as c FROM win_history').get() as { c: number })
      .c;
    expect(count).toBe(1);
  });

  it('相同 user_id + 不同 round_id 允许并存（保留历史）', () => {
    const { postId, roundId: r1 } = seedPostAndRound();

    const r2 = 'round_test_002';
    sqlite
      .prepare(
        `INSERT INTO draw_rounds
         (id, post_id, winner_count, rules, seed, commit_hash,
          candidate_ids, selected_ids, status, drawn_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        r2,
        postId,
        1,
        JSON.stringify({
          conditions: ['like'],
          relation: 'AND',
          filters: {},
          blacklistAtDraw: [],
          ignoreBlacklist: false,
        }),
        'c'.repeat(64),
        'd'.repeat(64),
        JSON.stringify(['u1']),
        JSON.stringify(['u1']),
        'drawn',
        Date.now(),
      );

    const now = Date.now();
    const insert = sqlite.prepare(
      `INSERT INTO win_history (user_id, round_id, post_id, prize_name, won_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, round_id) DO NOTHING`,
    );
    insert.run('user_alpha', r1, postId, 'p', now);
    insert.run('user_alpha', r2, postId, 'p', now + 100);

    const count = (
      sqlite
        .prepare('SELECT COUNT(*) as c FROM win_history WHERE user_id = ?')
        .get('user_alpha') as { c: number }
    ).c;
    expect(count).toBe(2);
  });
});

// ============================================================================
// interactions UNIQUE (post_id, user_id)
// ============================================================================

describe('interactions — (post_id, user_id) UNIQUE', () => {
  it('同 post + 同 user 重复插入应触发 UNIQUE constraint failed', () => {
    sqlite
      .prepare(
        `INSERT INTO posts (id, xsec_token, author_id, created_at, raw_url)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('note1', 'tok', 'me', Date.now(), 'https://x.test/');

    const insert = sqlite.prepare(
      `INSERT INTO interactions (post_id, user_id, types, fetched_at)
       VALUES (?, ?, ?, ?)`,
    );

    insert.run('note1', 'user_x', JSON.stringify(['like']), Date.now());

    expect(() => insert.run('note1', 'user_x', JSON.stringify(['comment']), Date.now())).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it('UPSERT (ON CONFLICT DO UPDATE) 以最新为准的语义可用（R7.6）', () => {
    sqlite
      .prepare(
        `INSERT INTO posts (id, xsec_token, author_id, created_at, raw_url)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('note1', 'tok', 'me', Date.now(), 'https://x.test/');

    const upsert = sqlite.prepare(
      `INSERT INTO interactions (post_id, user_id, types, fetched_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(post_id, user_id) DO UPDATE SET
         types = excluded.types,
         fetched_at = excluded.fetched_at`,
    );

    upsert.run('note1', 'user_x', JSON.stringify(['like']), 1_000);
    upsert.run('note1', 'user_x', JSON.stringify(['like', 'comment']), 2_000);

    const row = sqlite
      .prepare('SELECT types, fetched_at FROM interactions WHERE post_id = ? AND user_id = ?')
      .get('note1', 'user_x') as { types: string; fetched_at: number };

    expect(JSON.parse(row.types)).toEqual(['like', 'comment']);
    expect(row.fetched_at).toBe(2_000);
  });
});

// ============================================================================
// 外键级联删除
// ============================================================================

describe('外键 — 删除 post 级联清理下游', () => {
  it('删除 post 后 interactions / draw_rounds 一并清掉', () => {
    sqlite
      .prepare(
        `INSERT INTO posts (id, xsec_token, author_id, created_at, raw_url)
         VALUES ('note1', 'tok', 'me', 1, 'https://x.test/')`,
      )
      .run();

    sqlite
      .prepare(
        `INSERT INTO interactions (post_id, user_id, types, fetched_at)
         VALUES ('note1', 'u1', '["like"]', 1)`,
      )
      .run();

    sqlite
      .prepare(
        `INSERT INTO draw_rounds
         (id, post_id, winner_count, rules, seed, commit_hash,
          candidate_ids, selected_ids, status, drawn_at)
         VALUES ('r1', 'note1', 1,
                 '{"conditions":["like"],"relation":"AND","filters":{},"blacklistAtDraw":[],"ignoreBlacklist":false}',
                 'a', 'b', '["u1"]', '["u1"]', 'drawn', 1)`,
      )
      .run();

    sqlite.prepare('DELETE FROM posts WHERE id = ?').run('note1');

    const ia = (sqlite.prepare('SELECT COUNT(*) as c FROM interactions').get() as { c: number }).c;
    const dr = (sqlite.prepare('SELECT COUNT(*) as c FROM draw_rounds').get() as { c: number }).c;

    expect(ia).toBe(0);
    expect(dr).toBe(0);
  });
});
