import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { derive, draw, InvalidDrawInputError, PoolInsufficientError, verify } from './draw';

const USER_SECRET = 'test-local-secret-32bytes-0123456789abcdef';

/** 生成长度为 n 的候选池，user_id 递增便于断言 */
function makePool(n: number, prefix = 'u'): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(4, '0')}`);
}

describe('draw — 基本输入校验', () => {
  it('winnerCount 为 0 时抛 InvalidDrawInputError', () => {
    expect(() => draw({ poolIds: makePool(10), winnerCount: 0, userSecret: USER_SECRET })).toThrow(
      InvalidDrawInputError,
    );
  });

  it('winnerCount 为负数时抛 InvalidDrawInputError', () => {
    expect(() => draw({ poolIds: makePool(10), winnerCount: -1, userSecret: USER_SECRET })).toThrow(
      InvalidDrawInputError,
    );
  });

  it('winnerCount 为小数时抛 InvalidDrawInputError', () => {
    expect(() =>
      draw({ poolIds: makePool(10), winnerCount: 2.5, userSecret: USER_SECRET }),
    ).toThrow(InvalidDrawInputError);
  });

  it('userSecret 为空时抛 InvalidDrawInputError', () => {
    expect(() => draw({ poolIds: makePool(10), winnerCount: 3, userSecret: '' })).toThrow(
      InvalidDrawInputError,
    );
  });

  it('显式传入非 hex seed 时抛 InvalidDrawInputError', () => {
    expect(() =>
      draw({
        poolIds: makePool(10),
        winnerCount: 3,
        userSecret: USER_SECRET,
        seed: 'not-a-hex-string!!',
      }),
    ).toThrow(InvalidDrawInputError);
  });
});

describe('draw — 候选池充足性（对应 R11.5 / P5）', () => {
  it('候选池小于 winnerCount 时抛 PoolInsufficientError', () => {
    expect(() => draw({ poolIds: makePool(3), winnerCount: 5, userSecret: USER_SECRET })).toThrow(
      PoolInsufficientError,
    );
  });

  it('候选池等于 winnerCount 时全部入选', () => {
    const pool = makePool(5);
    const result = draw({ poolIds: pool, winnerCount: 5, userSecret: USER_SECRET });
    expect(result.winners).toHaveLength(5);
    expect(new Set(result.winners)).toEqual(new Set(pool));
  });

  it('重复 user_id 的候选池会被去重后再判断充足性', () => {
    // 名义上 6 个，去重后只剩 3 个
    const pool = ['u1', 'u2', 'u3', 'u1', 'u2', 'u3'];
    expect(() => draw({ poolIds: pool, winnerCount: 5, userSecret: USER_SECRET })).toThrow(
      PoolInsufficientError,
    );
  });

  it('候选池去重后恰好够 winnerCount 时正常开奖', () => {
    const pool = ['u1', 'u2', 'u3', 'u1', 'u2', 'u3'];
    const result = draw({ poolIds: pool, winnerCount: 3, userSecret: USER_SECRET });
    expect(result.winners).toHaveLength(3);
    // 中奖者不可能出现重复
    expect(new Set(result.winners).size).toBe(3);
  });
});

describe('draw — Commit 哈希正确性（对应 R11.1）', () => {
  it('commitHash 严格等于 SHA-256(seed)', () => {
    const pool = makePool(20);
    const result = draw({ poolIds: pool, winnerCount: 3, userSecret: USER_SECRET });
    const expected = createHash('sha256').update(result.seed).digest('hex');
    expect(result.commitHash).toBe(expected);
  });

  it('seed 总是 64 字符 hex（32 字节）', () => {
    const result = draw({
      poolIds: makePool(10),
      winnerCount: 2,
      userSecret: USER_SECRET,
    });
    expect(result.seed).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('draw — 幂等性（对应 R11.3, R11.6 / P1）', () => {
  it('相同 (seed, pool, winnerCount, userSecret) 两次调用产出严格相同的 winners', () => {
    const pool = makePool(50);
    const seed = 'a'.repeat(64);
    const a = draw({ poolIds: pool, winnerCount: 5, userSecret: USER_SECRET, seed });
    const b = draw({ poolIds: pool, winnerCount: 5, userSecret: USER_SECRET, seed });
    expect(a.winners).toEqual(b.winners);
    expect(a.indices).toEqual(b.indices);
    expect(a.commitHash).toBe(b.commitHash);
  });

  it('不同 userSecret 产出不同 winners', () => {
    const pool = makePool(50);
    const seed = 'a'.repeat(64);
    const a = draw({ poolIds: pool, winnerCount: 5, userSecret: 'secret-A', seed });
    const b = draw({ poolIds: pool, winnerCount: 5, userSecret: 'secret-B', seed });
    expect(a.winners).not.toEqual(b.winners);
  });

  it('不同 seed 产出不同 winners', () => {
    const pool = makePool(50);
    const a = draw({
      poolIds: pool,
      winnerCount: 5,
      userSecret: USER_SECRET,
      seed: 'a'.repeat(64),
    });
    const b = draw({
      poolIds: pool,
      winnerCount: 5,
      userSecret: USER_SECRET,
      seed: 'b'.repeat(64),
    });
    expect(a.winners).not.toEqual(b.winners);
  });
});

describe('draw — 中奖者唯一性', () => {
  it('winners 内部无重复', () => {
    const pool = makePool(1000);
    const result = draw({ poolIds: pool, winnerCount: 100, userSecret: USER_SECRET });
    expect(new Set(result.winners).size).toBe(100);
  });

  it('所有 winners 都来自输入池', () => {
    const pool = makePool(20);
    const poolSet = new Set(pool);
    const result = draw({ poolIds: pool, winnerCount: 5, userSecret: USER_SECRET });
    for (const w of result.winners) {
      expect(poolSet.has(w)).toBe(true);
    }
  });
});

describe('verify — 第三方复算审计', () => {
  it('合法 seed + 合法 winners → ok', () => {
    const pool = makePool(30);
    const drawn = draw({ poolIds: pool, winnerCount: 3, userSecret: USER_SECRET });

    const result = verify({
      poolIds: pool,
      winnerCount: 3,
      userSecret: USER_SECRET,
      seed: drawn.seed,
      publishedWinners: drawn.winners,
      publishedCommitHash: drawn.commitHash,
    });

    expect(result.ok).toBe(true);
  });

  it('篡改 published winners → winners_mismatch', () => {
    const pool = makePool(30);
    const drawn = draw({ poolIds: pool, winnerCount: 3, userSecret: USER_SECRET });
    const tampered = [...drawn.winners];
    tampered[0] = pool[pool.length - 1] as string; // 改第一个中奖者为别人

    const result = verify({
      poolIds: pool,
      winnerCount: 3,
      userSecret: USER_SECRET,
      seed: drawn.seed,
      publishedWinners: tampered,
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('winners_mismatch');
  });

  it('篡改 publishedCommitHash → commit_hash_mismatch', () => {
    const pool = makePool(30);
    const drawn = draw({ poolIds: pool, winnerCount: 3, userSecret: USER_SECRET });

    const result = verify({
      poolIds: pool,
      winnerCount: 3,
      userSecret: USER_SECRET,
      seed: drawn.seed,
      publishedWinners: drawn.winners,
      publishedCommitHash: 'deadbeef'.repeat(8),
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('commit_hash_mismatch');
  });
});

describe('derive — 补抽派生', () => {
  it('相同排除集合产出相同 winner（幂等）', () => {
    const pool = makePool(30);
    const originalSeed = 'c'.repeat(64);
    const excluded = ['u0003', 'u0007'];

    const a = derive({
      poolIds: pool,
      originalSeed,
      excludedIds: excluded,
      userSecret: USER_SECRET,
    });
    const b = derive({
      poolIds: pool,
      originalSeed,
      excludedIds: excluded,
      userSecret: USER_SECRET,
    });

    expect(a.winners).toEqual(b.winners);
    expect(a.seed).toBe(b.seed);
  });

  it('排除集合顺序无关（内部会排序）', () => {
    const pool = makePool(30);
    const originalSeed = 'c'.repeat(64);

    const a = derive({
      poolIds: pool,
      originalSeed,
      excludedIds: ['u0003', 'u0007'],
      userSecret: USER_SECRET,
    });
    const b = derive({
      poolIds: pool,
      originalSeed,
      excludedIds: ['u0007', 'u0003'],
      userSecret: USER_SECRET,
    });

    expect(a.winners).toEqual(b.winners);
    expect(a.seed).toBe(b.seed);
  });

  it('不同排除集合产出不同 winner', () => {
    const pool = makePool(30);
    const originalSeed = 'c'.repeat(64);

    const a = derive({
      poolIds: pool,
      originalSeed,
      excludedIds: ['u0003'],
      userSecret: USER_SECRET,
    });
    const b = derive({
      poolIds: pool,
      originalSeed,
      excludedIds: ['u0005'],
      userSecret: USER_SECRET,
    });

    expect(a.winners).not.toEqual(b.winners);
  });

  it('补抽结果不包含被排除的 id', () => {
    const pool = makePool(30);
    const originalSeed = 'c'.repeat(64);
    const excluded = ['u0003', 'u0007', 'u0010'];

    const result = derive({
      poolIds: pool,
      originalSeed,
      excludedIds: excluded,
      userSecret: USER_SECRET,
      winnerCount: 3,
    });

    for (const w of result.winners) {
      expect(excluded).not.toContain(w);
    }
  });
});
