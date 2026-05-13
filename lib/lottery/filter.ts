/**
 * BitSet 条件过滤器（AND / OR）
 *
 * 对应 requirements.md R9（条件过滤与 AND/OR 关系）。
 *
 * 设计：
 *   - 四种条件 like / collect / follow / comment 各占 1 bit
 *   - userBits & ruleMask 一次位运算判 AND/OR，比嵌套 if 清晰、比 every 快
 *   - 扩展新条件只需加一个 bit 常量 + conditionBit 映射
 *
 * 与 draw.ts 衔接：filterCandidates 产出的 InteractionLike[] 经过去重后可直接
 * 作为 Candidate_Pool 喂给 draw()。
 */

import type { InteractionType } from '../db/schema';

// ============================================================================
// Bit flags
// ============================================================================

export const BIT_LIKE = 1 << 0;
export const BIT_COLLECT = 1 << 1;
export const BIT_FOLLOW = 1 << 2;
export const BIT_COMMENT = 1 << 3;

const CONDITION_BITS: Record<InteractionType, number> = {
  like: BIT_LIKE,
  collect: BIT_COLLECT,
  follow: BIT_FOLLOW,
  comment: BIT_COMMENT,
};

export function conditionBit(c: InteractionType): number {
  return CONDITION_BITS[c];
}

// ============================================================================
// Types
// ============================================================================

/**
 * 过滤器依赖的最小用户形态。
 * 注意：`followed` 语义是「用户是否关注博主」，对应 InteractionType 的 follow。
 */
export interface FilterableUser {
  readonly userId: string;
  readonly types: readonly InteractionType[];
  readonly followedBlogger?: boolean;
}

export type LotteryRelation = 'AND' | 'OR';

export interface LotteryFilterRule {
  readonly conditions: readonly InteractionType[];
  readonly relation: LotteryRelation;
}

// ============================================================================
// Errors
// ============================================================================

export class EmptyConditionError extends Error {
  readonly code = 'empty_condition' as const;

  constructor() {
    super('条件列表为空，请至少选择一个互动类型');
    this.name = 'EmptyConditionError';
  }
}

// ============================================================================
// Core
// ============================================================================

/**
 * 把一个用户的互动类型集合压缩成 4 bit。
 *
 * 若 user.followedBlogger === true，自动补上 follow bit。
 */
export function buildUserBits(user: FilterableUser): number {
  let bits = 0;
  for (const t of user.types) bits |= conditionBit(t);
  if (user.followedBlogger) bits |= BIT_FOLLOW;
  return bits;
}

/**
 * 把规则条件集合压缩成 mask。
 */
export function buildRuleMask(conditions: readonly InteractionType[]): number {
  if (conditions.length === 0) throw new EmptyConditionError();
  let mask = 0;
  for (const c of conditions) mask |= conditionBit(c);
  return mask;
}

/**
 * 判断单个用户是否符合规则。
 */
export function matches(userBits: number, mask: number, relation: LotteryRelation): boolean {
  if (relation === 'AND') return (userBits & mask) === mask;
  return (userBits & mask) !== 0;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * 批量过滤候选池。
 *
 * 顺序：
 *   1. 校验条件非空（否则抛 EmptyConditionError）
 *   2. 对每个用户计算 userBits，按 relation 判断命中
 *   3. 剔除黑名单 user_id
 *
 * 注意：本函数不负责低质过滤（`quality.ts`）或入池去重（`draw.ts` 会做）。
 */
export function filterCandidates<T extends FilterableUser>(
  users: readonly T[],
  rule: LotteryFilterRule,
  blacklist: ReadonlySet<string> = new Set(),
): T[] {
  const mask = buildRuleMask(rule.conditions);
  const out: T[] = [];
  for (const u of users) {
    if (blacklist.has(u.userId)) continue;
    if (matches(buildUserBits(u), mask, rule.relation)) {
      out.push(u);
    }
  }
  return out;
}
