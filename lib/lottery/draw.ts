/**
 * HMAC-DRBG Commit-Reveal Lottery Algorithm
 *
 * 参考 design.md §2.2 与 requirements.md R11（可验证随机抽取）。
 *
 * 核心思想：
 *   1. Commit 阶段：随机生成 32 字节 seed，公布 SHA-256(seed) 作为承诺
 *   2. Reveal 阶段：用 seed + userSecret 驱动 HMAC-DRBG 派生随机索引
 *   3. 任何第三方拿到 (seed, poolIds, winnerCount, userSecret) 可独立复算并验证
 *
 * 为什么选 HMAC-DRBG：
 *   - `Math.random` 不可复算不可审计
 *   - 纯区块哈希对小额抽奖过度工程
 *   - HMAC-DRBG 是 NIST SP 800-90A 工业标准，确定性、不可预测、可复算
 */

import { createHash, createHmac, randomBytes } from 'node:crypto';

// ============================================================================
// Types
// ============================================================================

export interface DrawInput {
  /** 候选用户 id 有序集合；函数内部会去重。必须非空。 */
  readonly poolIds: readonly string[];
  /** 要抽出的中奖人数。必须 > 0 且 ≤ 去重后的 poolIds.length。 */
  readonly winnerCount: number;
  /** 本地 HMAC 密钥（仅本机持有）。 */
  readonly userSecret: string;
  /**
   * 可选：显式指定 seed（用于验证模式 verify 或补抽模式 derive）。
   * 不传则内部随机生成 32 字节 seed。
   */
  readonly seed?: string;
}

export interface DrawResult {
  /** 32 字节 hex seed；开奖时公布给用户留存。 */
  readonly seed: string;
  /** SHA-256(seed) 的 hex 摘要；开奖前可先公布给粉丝做承诺。 */
  readonly commitHash: string;
  /** 按抽取顺序排列的中奖 user_id 列表。 */
  readonly winners: readonly string[];
  /** winners 对应去重后 poolIds 的下标，便于审计。 */
  readonly indices: readonly number[];
}

// ============================================================================
// Errors
// ============================================================================

export class PoolInsufficientError extends Error {
  readonly code = 'pool_insufficient' as const;

  constructor(
    readonly poolSize: number,
    readonly winnerCount: number,
  ) {
    super(`候选池只有 ${poolSize} 人，不够抽 ${winnerCount} 个`);
    this.name = 'PoolInsufficientError';
  }
}

export class InvalidDrawInputError extends Error {
  readonly code = 'invalid_draw_input' as const;

  constructor(message: string) {
    super(message);
    this.name = 'InvalidDrawInputError';
  }
}

// ============================================================================
// Core draw
// ============================================================================

/**
 * 执行一次 commit-reveal 抽奖。
 *
 * 幂等性保证：对相同的 (seed, poolIds, winnerCount, userSecret) 两次调用产出
 * 完全一致的 winners 顺序；不传 seed 时由内部随机生成。
 */
export function draw(input: DrawInput): DrawResult {
  const { poolIds, winnerCount, userSecret } = input;

  // 输入校验
  if (winnerCount <= 0 || !Number.isInteger(winnerCount)) {
    throw new InvalidDrawInputError(`winnerCount 必须是正整数，实际为 ${winnerCount}`);
  }
  if (userSecret.length === 0) {
    throw new InvalidDrawInputError('userSecret 不能为空字符串');
  }

  // 入口去重：保证同一 user_id 只可能中一次
  const deduped = dedupePreservingOrder(poolIds);
  if (deduped.length < winnerCount) {
    throw new PoolInsufficientError(deduped.length, winnerCount);
  }

  // Seed：验证/派生模式由调用方传入；开奖模式内部随机生成
  const seed = input.seed ?? randomBytes(32).toString('hex');
  if (!/^[0-9a-f]+$/i.test(seed)) {
    throw new InvalidDrawInputError('seed 必须是 hex 字符串');
  }

  const commitHash = createHash('sha256').update(seed).digest('hex');

  // HMAC-DRBG：以 userSecret 为 key，seed + counter 为 input，循环派生 uint32 索引
  const picked = new Set<number>();
  const indices: number[] = [];
  let counter = 0;

  while (indices.length < winnerCount) {
    const counterBuf = Buffer.alloc(4);
    counterBuf.writeUInt32BE(counter++, 0);

    const block = createHmac('sha256', userSecret).update(seed, 'hex').update(counterBuf).digest();

    // 把 32 字节 HMAC 输出切成 8 个 uint32，逐个映射到 poolIds 下标
    for (let off = 0; off + 4 <= block.length && indices.length < winnerCount; off += 4) {
      const raw = block.readUInt32BE(off);
      const idx = raw % deduped.length;
      if (!picked.has(idx)) {
        picked.add(idx);
        indices.push(idx);
      }
    }

    // 防御：counter 溢出之前应该已经填满（实际上池子足够大时几乎不会触发）
    if (counter > 2 ** 24) {
      throw new Error('HMAC-DRBG counter 异常溢出——candidate pool 可能存在严重退化');
    }
  }

  const winners = indices.map((i) => {
    const id = deduped[i];
    // 理论上不可能命中——deduped 已按 indices 合法边界派生
    if (id === undefined) {
      throw new Error('内部一致性错误：索引越界');
    }
    return id;
  });

  return { seed, commitHash, winners, indices };
}

// ============================================================================
// Verify
// ============================================================================

export interface VerifyInput {
  readonly poolIds: readonly string[];
  readonly winnerCount: number;
  readonly userSecret: string;
  readonly seed: string;
  readonly publishedWinners: readonly string[];
  readonly publishedCommitHash?: string;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly reason?: 'winners_mismatch' | 'commit_hash_mismatch' | 'recomputation_failed';
  readonly recomputed?: DrawResult;
}

/**
 * 验证一次公布的抽奖结果是否与声称的 seed / commit 一致。
 *
 * 第三方只需拿到 (poolIds, winnerCount, userSecret, seed, publishedWinners[, publishedCommitHash])
 * 就能独立判断「博主有没有篡改开奖结果」。
 */
export function verify(input: VerifyInput): VerifyResult {
  let recomputed: DrawResult;
  try {
    recomputed = draw({
      poolIds: input.poolIds,
      winnerCount: input.winnerCount,
      userSecret: input.userSecret,
      seed: input.seed,
    });
  } catch {
    return { ok: false, reason: 'recomputation_failed' };
  }

  if (
    input.publishedCommitHash !== undefined &&
    recomputed.commitHash !== input.publishedCommitHash
  ) {
    return { ok: false, reason: 'commit_hash_mismatch', recomputed };
  }

  if (!arraysStrictEqual(recomputed.winners, input.publishedWinners)) {
    return { ok: false, reason: 'winners_mismatch', recomputed };
  }

  return { ok: true, recomputed };
}

// ============================================================================
// Derive (补抽)
// ============================================================================

export interface DeriveInput {
  readonly poolIds: readonly string[];
  readonly originalSeed: string;
  readonly excludedIds: readonly string[];
  readonly userSecret: string;
  /** 要补抽的人数，默认 1。 */
  readonly winnerCount?: number;
}

/**
 * 基于原始 seed + 被排除的 user_ids 派生新的抽奖输入。
 *
 * 设计意图：当用户在手动确认面板里取消了某几个候选，点「补抽一名」时，
 * 我们不希望重新随机—— 而是用「原 seed + excluded set」生成一个确定的新 seed，
 * 这样同样的排除集合永远产出同样的补抽结果，仍然可复算。
 *
 * 排除集合内部会先排序再参与派生，保证顺序无关。
 */
export function derive(input: DeriveInput): DrawResult {
  const { poolIds, originalSeed, excludedIds, userSecret } = input;
  const winnerCount = input.winnerCount ?? 1;

  // 从 poolIds 中剔除 excludedIds
  const excludedSet = new Set(excludedIds);
  const reducedPool = poolIds.filter((id) => !excludedSet.has(id));

  // 派生新 seed：原 seed || sorted(excluded) 的 JSON，SHA-256 取 32 字节 hex
  // 排序保证顺序无关；JSON stringify 保证分隔符确定
  const sortedExcluded = [...excludedIds].sort();
  const derivedSeed = createHash('sha256')
    .update(originalSeed, 'hex')
    .update('||redraw||')
    .update(JSON.stringify(sortedExcluded))
    .digest('hex');

  return draw({
    poolIds: reducedPool,
    winnerCount,
    userSecret,
    seed: derivedSeed,
  });
}

// ============================================================================
// Helpers
// ============================================================================

function dedupePreservingOrder(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function arraysStrictEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
