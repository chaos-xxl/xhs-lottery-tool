/**
 * Property-Based Test: Filter Correctness (P2)
 *
 * 对应 requirements.md Correctness Property #2：
 *   "AND 模式下所有候选命中全部条件；OR 模式下所有候选至少命中一个条件；所有候选都不在 blacklist 中。"
 *
 * 对应 tasks.md Task 8.2，映射 Requirements 9.2 / 9.3。
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { InteractionType } from '../db/schema';
import { type FilterableUser, filterCandidates } from './filter';

const ALL_INTERACTIONS: readonly InteractionType[] = [
  'like',
  'collect',
  'follow',
  'comment',
] as const;

const interactionTypeArb = fc.constantFrom(...ALL_INTERACTIONS);

const userArb = fc.record({
  userId: fc.string({
    minLength: 3,
    maxLength: 20,
    unit: fc.constantFrom(...'abcdefghijklmnop0123456789'.split('')),
  }),
  types: fc
    .uniqueArray(interactionTypeArb, { minLength: 0, maxLength: 4 })
    .map((arr) => arr as readonly InteractionType[]),
  followedBlogger: fc.boolean(),
});

const nonEmptyConditionsArb = fc.uniqueArray(interactionTypeArb, {
  minLength: 1,
  maxLength: 4,
});

const relationArb = fc.constantFrom<'AND' | 'OR'>('AND', 'OR');

// 给每个 user 补一个稳定 userId（fast-check 可能产出重复 userId，过滤阶段不关心，但方便断言）
function ensureUniqueIds(users: FilterableUser[]): FilterableUser[] {
  const seen = new Set<string>();
  return users.map((u, i) => {
    let id = u.userId;
    let suffix = 0;
    while (seen.has(id)) {
      id = `${u.userId}_${i}_${suffix++}`;
    }
    seen.add(id);
    return { ...u, userId: id };
  });
}

describe('PBT P2 — AND / OR 过滤正确性', () => {
  it('AND 模式下每个候选的 bits 完全覆盖 mask', () => {
    fc.assert(
      fc.property(
        fc.array(userArb, { minLength: 0, maxLength: 50 }).map(ensureUniqueIds),
        nonEmptyConditionsArb,
        (users, conditions) => {
          const out = filterCandidates(users, { conditions, relation: 'AND' });

          for (const u of out) {
            const typeSet = new Set(u.types);
            if (u.followedBlogger) typeSet.add('follow');
            // 每个所选条件都必须被该用户覆盖
            for (const c of conditions) {
              expect(typeSet.has(c)).toBe(true);
            }
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('OR 模式下每个候选至少命中一个条件', () => {
    fc.assert(
      fc.property(
        fc.array(userArb, { minLength: 0, maxLength: 50 }).map(ensureUniqueIds),
        nonEmptyConditionsArb,
        (users, conditions) => {
          const out = filterCandidates(users, { conditions, relation: 'OR' });

          for (const u of out) {
            const typeSet = new Set(u.types);
            if (u.followedBlogger) typeSet.add('follow');
            const hit = conditions.some((c) => typeSet.has(c));
            expect(hit).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('blacklist 中的 user_id 必不出现在过滤结果中', () => {
    fc.assert(
      fc.property(
        fc.array(userArb, { minLength: 1, maxLength: 40 }).map(ensureUniqueIds),
        nonEmptyConditionsArb,
        relationArb,
        (users, conditions, relation) => {
          // 随机选一半 user_id 进黑名单
          const allIds = users.map((u) => u.userId);
          const black = new Set(allIds.filter((_, i) => i % 2 === 0));

          const out = filterCandidates(users, { conditions, relation }, black);

          for (const u of out) {
            expect(black.has(u.userId)).toBe(false);
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  it('输入规模保守性：AND 结果 ⊆ OR 结果（相同 conditions / blacklist）', () => {
    fc.assert(
      fc.property(
        fc.array(userArb, { minLength: 0, maxLength: 30 }).map(ensureUniqueIds),
        nonEmptyConditionsArb,
        (users, conditions) => {
          const andIds = new Set(
            filterCandidates(users, { conditions, relation: 'AND' }).map((u) => u.userId),
          );
          const orIds = new Set(
            filterCandidates(users, { conditions, relation: 'OR' }).map((u) => u.userId),
          );

          for (const id of andIds) {
            expect(orIds.has(id)).toBe(true);
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
