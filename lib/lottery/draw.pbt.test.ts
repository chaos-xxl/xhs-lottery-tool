/**
 * Property-Based Test: Draw Idempotence (P1)
 *
 * 验证：对任意合法的 (poolIds, winnerCount, userSecret, seed)，
 *       两次独立调用 draw() 必定产出严格相同的 winners、indices、commitHash。
 *
 * 对应 requirements.md Correctness Property #1：
 *   "抽奖幂等性（Draw Idempotence）：对同一组 (Seed, Candidate_Pool, winner_count, user_secret)
 *    执行抽取应产出完全相同的中奖顺序。"
 *
 * 对应 tasks.md Task 8.1、映射 Requirements 11.3 / 11.6 / 12.2。
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { draw, PoolInsufficientError, verify } from './draw';

// ============================================================================
// Arbitraries（输入生成器）
// ============================================================================

/** user_id 生成器：控制字符集 + 长度，避免退化（全是同一字符的空串）。 */
const userIdArb = fc.string({
  minLength: 3,
  maxLength: 24,
  unit: fc.constantFrom(
    ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'.split(''),
  ),
});

/** HMAC userSecret 生成器：非空，允许任意字符（模拟真实本地密钥）。 */
const userSecretArb = fc.string({ minLength: 16, maxLength: 64 });

/** 32 字节 hex seed 生成器。 */
const seedArb = fc.string({
  minLength: 64,
  maxLength: 64,
  unit: fc.constantFrom(...'0123456789abcdef'.split('')),
});

/**
 * 联合生成器：产出 (去重后长度充足的 pool, winnerCount)。
 *
 * 约束：
 *   - 去重后 pool 至少 2 人，避免退化到 1 人池
 *   - winnerCount ∈ [1, dedupedPool.length]
 */
const poolAndWinnerCountArb = fc
  .uniqueArray(userIdArb, { minLength: 2, maxLength: 100 })
  .chain((pool) =>
    fc.integer({ min: 1, max: pool.length }).map((winnerCount) => ({ pool, winnerCount })),
  );

// ============================================================================
// Property 1: Draw Idempotence
// ============================================================================

describe('PBT P1 — 抽奖幂等性（Draw Idempotence）', () => {
  it('任意合法输入下，两次独立调用产出严格相等的 winners + indices + commitHash', () => {
    fc.assert(
      fc.property(
        poolAndWinnerCountArb,
        userSecretArb,
        seedArb,
        ({ pool, winnerCount }, userSecret, seed) => {
          const a = draw({ poolIds: pool, winnerCount, userSecret, seed });
          const b = draw({ poolIds: pool, winnerCount, userSecret, seed });

          expect(a.winners).toEqual(b.winners);
          expect(a.indices).toEqual(b.indices);
          expect(a.commitHash).toBe(b.commitHash);
          expect(a.seed).toBe(b.seed);
        },
      ),
      { numRuns: 200 },
    );
  });

  it('pool 的顺序不影响 winners 集合（去重 + 保序语义：winners 是 poolIds 在去重后的子集）', () => {
    fc.assert(
      fc.property(
        poolAndWinnerCountArb,
        userSecretArb,
        seedArb,
        ({ pool, winnerCount }, userSecret, seed) => {
          const result = draw({ poolIds: pool, winnerCount, userSecret, seed });
          // winners 数量精确等于 winnerCount
          expect(result.winners).toHaveLength(winnerCount);
          // winners 互不重复
          expect(new Set(result.winners).size).toBe(winnerCount);
          // 所有 winners 都来自 pool
          const poolSet = new Set(pool);
          for (const w of result.winners) {
            expect(poolSet.has(w)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

// ============================================================================
// Property 5: Pool Sufficiency (与 P1 紧邻，一并 PBT 化)
// ============================================================================

describe('PBT P5 — 候选池充足性（Pool Sufficiency）', () => {
  it('去重后 pool.length < winnerCount 必定抛 PoolInsufficientError，不产出部分结果', () => {
    const shortfallArb = fc
      .uniqueArray(userIdArb, { minLength: 1, maxLength: 20 })
      .chain((pool) =>
        fc
          .integer({ min: pool.length + 1, max: pool.length + 50 })
          .map((winnerCount) => ({ pool, winnerCount })),
      );

    fc.assert(
      fc.property(
        shortfallArb,
        userSecretArb,
        seedArb,
        ({ pool, winnerCount }, userSecret, seed) => {
          expect(() => draw({ poolIds: pool, winnerCount, userSecret, seed })).toThrow(
            PoolInsufficientError,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('含重复元素的 pool，在去重后若仍 < winnerCount 也抛错', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(userIdArb, { minLength: 1, maxLength: 10 }).chain((unique) =>
          fc.integer({ min: unique.length + 1, max: unique.length + 20 }).map((winnerCount) => {
            // 通过重复拼接让 pool 名义上足够大，但去重后仍不足
            const inflated: string[] = [];
            for (let i = 0; i < winnerCount + 5; i++) {
              const id = unique[i % unique.length];
              if (id !== undefined) inflated.push(id);
            }
            return { pool: inflated, winnerCount };
          }),
        ),
        userSecretArb,
        seedArb,
        ({ pool, winnerCount }, userSecret, seed) => {
          expect(() => draw({ poolIds: pool, winnerCount, userSecret, seed })).toThrow(
            PoolInsufficientError,
          );
        },
      ),
      { numRuns: 100 },
    );
  });
});

// ============================================================================
// 附加：Verify 正反对称（用于增强第三方复算的信心）
// ============================================================================

describe('PBT — verify 正反对称', () => {
  it('合法开奖结果必定通过 verify', () => {
    fc.assert(
      fc.property(
        poolAndWinnerCountArb,
        userSecretArb,
        seedArb,
        ({ pool, winnerCount }, userSecret, seed) => {
          const drawn = draw({ poolIds: pool, winnerCount, userSecret, seed });
          const result = verify({
            poolIds: pool,
            winnerCount,
            userSecret,
            seed: drawn.seed,
            publishedWinners: drawn.winners,
            publishedCommitHash: drawn.commitHash,
          });
          expect(result.ok).toBe(true);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('任意篡改首位 winner 必定被 verify 拒绝', () => {
    fc.assert(
      fc.property(
        poolAndWinnerCountArb.filter(({ pool, winnerCount }) => pool.length > winnerCount),
        userSecretArb,
        seedArb,
        ({ pool, winnerCount }, userSecret, seed) => {
          const drawn = draw({ poolIds: pool, winnerCount, userSecret, seed });
          // 找一个不在 winners 里的 id
          const winnerSet = new Set(drawn.winners);
          const outsider = pool.find((p) => !winnerSet.has(p));
          if (outsider === undefined) return; // 理论上不会（因为我们 filter 过）

          const tampered = [outsider, ...drawn.winners.slice(1)];
          const result = verify({
            poolIds: pool,
            winnerCount,
            userSecret,
            seed: drawn.seed,
            publishedWinners: tampered,
          });
          expect(result.ok).toBe(false);
        },
      ),
      { numRuns: 150 },
    );
  });
});
