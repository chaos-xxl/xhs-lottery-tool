import { describe, expect, it } from 'vitest';
import {
  BIT_COLLECT,
  BIT_COMMENT,
  BIT_FOLLOW,
  BIT_LIKE,
  buildRuleMask,
  buildUserBits,
  EmptyConditionError,
  type FilterableUser,
  filterCandidates,
  matches,
} from './filter';

describe('buildUserBits / buildRuleMask — 位运算基础', () => {
  it('types 映射到正确的 bit', () => {
    expect(buildUserBits({ userId: 'u', types: ['like'] })).toBe(BIT_LIKE);
    expect(buildUserBits({ userId: 'u', types: ['collect'] })).toBe(BIT_COLLECT);
    expect(buildUserBits({ userId: 'u', types: ['follow'] })).toBe(BIT_FOLLOW);
    expect(buildUserBits({ userId: 'u', types: ['comment'] })).toBe(BIT_COMMENT);
  });

  it('followedBlogger=true 时自动补 follow bit', () => {
    const bits = buildUserBits({ userId: 'u', types: ['like'], followedBlogger: true });
    expect((bits & BIT_LIKE) !== 0).toBe(true);
    expect((bits & BIT_FOLLOW) !== 0).toBe(true);
  });

  it('types 为空 → 0', () => {
    expect(buildUserBits({ userId: 'u', types: [] })).toBe(0);
  });

  it('buildRuleMask 对空条件抛 EmptyConditionError', () => {
    expect(() => buildRuleMask([])).toThrow(EmptyConditionError);
  });

  it('buildRuleMask 把多条件合并为位掩码', () => {
    expect(buildRuleMask(['like', 'comment'])).toBe(BIT_LIKE | BIT_COMMENT);
    expect(buildRuleMask(['like', 'collect', 'follow', 'comment'])).toBe(
      BIT_LIKE | BIT_COLLECT | BIT_FOLLOW | BIT_COMMENT,
    );
  });
});

describe('matches — AND / OR 语义', () => {
  it('AND 要求 userBits 包含 mask 的所有 bit', () => {
    const mask = BIT_LIKE | BIT_COMMENT;
    expect(matches(BIT_LIKE | BIT_COMMENT, mask, 'AND')).toBe(true);
    expect(matches(BIT_LIKE | BIT_COMMENT | BIT_COLLECT, mask, 'AND')).toBe(true);
    expect(matches(BIT_LIKE, mask, 'AND')).toBe(false); // 缺 comment
    expect(matches(0, mask, 'AND')).toBe(false);
  });

  it('OR 要求 userBits 至少包含 mask 的一位', () => {
    const mask = BIT_LIKE | BIT_COMMENT;
    expect(matches(BIT_LIKE, mask, 'OR')).toBe(true);
    expect(matches(BIT_COMMENT, mask, 'OR')).toBe(true);
    expect(matches(BIT_COLLECT, mask, 'OR')).toBe(false); // 没重叠
    expect(matches(0, mask, 'OR')).toBe(false);
  });
});

describe('filterCandidates — 批量过滤', () => {
  const users: FilterableUser[] = [
    { userId: 'u_like_only', types: ['like'] },
    { userId: 'u_comment_only', types: ['comment'] },
    { userId: 'u_like_comment', types: ['like', 'comment'] },
    { userId: 'u_all', types: ['like', 'collect', 'comment'], followedBlogger: true },
    { userId: 'u_none', types: [] },
  ];

  it('AND + [like, comment] → 仅保留同时命中两类的用户', () => {
    const filtered = filterCandidates(users, {
      conditions: ['like', 'comment'],
      relation: 'AND',
    });
    expect(filtered.map((u) => u.userId)).toEqual(['u_like_comment', 'u_all']);
  });

  it('OR + [like, comment] → 至少一个命中', () => {
    const filtered = filterCandidates(users, {
      conditions: ['like', 'comment'],
      relation: 'OR',
    });
    expect(filtered.map((u) => u.userId)).toEqual([
      'u_like_only',
      'u_comment_only',
      'u_like_comment',
      'u_all',
    ]);
  });

  it('AND + [follow, like] → 只返回关注 + 点赞都命中的用户（u_all）', () => {
    const filtered = filterCandidates(users, {
      conditions: ['follow', 'like'],
      relation: 'AND',
    });
    expect(filtered.map((u) => u.userId)).toEqual(['u_all']);
  });

  it('blacklist 中的 user_id 被剔除', () => {
    const filtered = filterCandidates(
      users,
      { conditions: ['like'], relation: 'OR' },
      new Set(['u_like_only', 'u_like_comment']),
    );
    expect(filtered.map((u) => u.userId)).toEqual(['u_all']);
  });

  it('空条件抛 EmptyConditionError', () => {
    expect(() => filterCandidates(users, { conditions: [], relation: 'OR' })).toThrow(
      EmptyConditionError,
    );
  });
});
