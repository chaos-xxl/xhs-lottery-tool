/**
 * fetchInteractions 单元测试
 *
 * 验证：
 *   - 评论 + 二级评论归一
 *   - 同一用户同时点赞 + 评论 → types 合并为 ['comment', 'like']
 *   - 401 中途中断 → 返回已抓部分 + abortReason='auth_error'
 *   - 1000 条上限触发中断 → abortReason='pool_cap'
 *   - follow 条件不触发任何粉丝列表接口调用
 */

import { describe, expect, it, vi } from 'vitest';
import { fetchInteractions, type InteractionRecord, mergeUser } from './fetch-interactions';
import { RateLimiter } from './rate-limiter';
import { XhsAuthError, type XhsClientLike, XhsRiskControlError } from './types';

function makeLimiter(cap = 10000): RateLimiter {
  return new RateLimiter({
    now: () => 0,
    sleep: async () => {},
    randomJitter: () => 0,
    minIntervalMs: 0,
    cooldownMs: 0,
    itemCapPerSession: cap,
  });
}

// ============================================================================
// mergeUser 纯函数测试
// ============================================================================

describe('mergeUser', () => {
  it('首次插入带齐全部字段', () => {
    const map = new Map<string, InteractionRecord>();
    mergeUser(map, {
      userId: 'u1',
      userNickname: 'Alice',
      userAvatar: 'http://avatar',
      followedBlogger: true,
      types: ['like'],
    });

    const r = map.get('u1');
    expect(r?.userNickname).toBe('Alice');
    expect(r?.types).toEqual(['like']);
    expect(r?.followedBlogger).toBe(true);
  });

  it('同一用户第二次合并 types', () => {
    const map = new Map<string, InteractionRecord>();
    mergeUser(map, { userId: 'u1', types: ['like'] });
    mergeUser(map, { userId: 'u1', types: ['comment'] });

    const r = map.get('u1');
    expect(r?.types.length).toBe(2);
    expect(new Set(r?.types)).toEqual(new Set(['like', 'comment']));
  });

  it('types 去重（同一类型重复不扩散）', () => {
    const map = new Map<string, InteractionRecord>();
    mergeUser(map, { userId: 'u1', types: ['like'] });
    mergeUser(map, { userId: 'u1', types: ['like'] });

    expect(map.get('u1')?.types).toEqual(['like']);
  });

  it('任一来源 followed=true 则保留 true', () => {
    const map = new Map<string, InteractionRecord>();
    mergeUser(map, { userId: 'u1', types: ['like'], followedBlogger: false });
    mergeUser(map, { userId: 'u1', types: ['comment'], followedBlogger: true });

    expect(map.get('u1')?.followedBlogger).toBe(true);
  });

  it('首个 commentText 被保留，后续不覆盖', () => {
    const map = new Map<string, InteractionRecord>();
    mergeUser(map, {
      userId: 'u1',
      types: ['comment'],
      commentText: '第一条',
      commentCreatedAt: 1000,
    });
    mergeUser(map, {
      userId: 'u1',
      types: ['comment'],
      commentText: '第二条',
      commentCreatedAt: 2000,
    });

    expect(map.get('u1')?.commentText).toBe('第一条');
    expect(map.get('u1')?.commentCreatedAt).toBe(1000);
  });

  it('用户扩展字段缺失时不加；后续补上', () => {
    const map = new Map<string, InteractionRecord>();
    mergeUser(map, { userId: 'u1', types: ['comment'] });
    expect(map.get('u1')?.userFollowsCount).toBeUndefined();

    mergeUser(map, { userId: 'u1', types: ['like'], userFollowsCount: 500, userFansCount: 20 });
    expect(map.get('u1')?.userFollowsCount).toBe(500);
    expect(map.get('u1')?.userFansCount).toBe(20);
  });
});

// ============================================================================
// fetchInteractions 集成测试
// ============================================================================

describe('fetchInteractions — 评论分页 + 二级评论归一', () => {
  it('一级评论 + 二级评论都合并到 users Map', async () => {
    const client: XhsClientLike = {
      get: vi.fn(async () => ({
        comments: [
          {
            id: 'c1',
            content: '一楼',
            create_time: 1000,
            user_info: { user_id: 'u1', nickname: 'A', image: '' },
            sub_comments: [
              {
                id: 'c1-sub1',
                content: '楼中楼',
                create_time: 1001,
                user_info: { user_id: 'u2', nickname: 'B', image: '' },
              },
            ],
          },
        ],
        cursor: '',
        has_more: false,
      })) as unknown as XhsClientLike['get'],
    };

    const result = await fetchInteractions(
      client,
      makeLimiter(),
      { noteId: 'n1', xsecToken: 't' },
      ['comment'],
    );

    expect(result.users.size).toBe(2);
    expect(result.users.get('u1')?.commentText).toBe('一楼');
    expect(result.users.get('u2')?.commentText).toBe('楼中楼');
    expect(result.abortReason).toBeUndefined();
  });

  it('分页 cursor 正确透传直到 has_more=false', async () => {
    const pages = [
      {
        comments: [
          {
            id: 'c1',
            content: '一',
            create_time: 1,
            user_info: { user_id: 'u1', nickname: '', image: '' },
          },
        ],
        cursor: 'next_cursor',
        has_more: true,
      },
      {
        comments: [
          {
            id: 'c2',
            content: '二',
            create_time: 2,
            user_info: { user_id: 'u2', nickname: '', image: '' },
          },
        ],
        cursor: '',
        has_more: false,
      },
    ];
    const spy = vi.fn(async () => pages.shift());

    const client: XhsClientLike = { get: spy as unknown as XhsClientLike['get'] };

    const result = await fetchInteractions(
      client,
      makeLimiter(),
      { noteId: 'n1', xsecToken: 't' },
      ['comment'],
    );

    expect(spy).toHaveBeenCalledTimes(2);
    expect(result.users.size).toBe(2);
  });
});

describe('fetchInteractions — 同一用户多类型合并', () => {
  it('用户 A 同时在点赞列表和评论列表 → types=[comment, like]', async () => {
    const client: XhsClientLike = {
      get: vi.fn(async (uri: string) => {
        if (uri.includes('comment/page')) {
          return {
            comments: [
              {
                id: 'c1',
                content: '好棒',
                create_time: 1,
                user_info: { user_id: 'uA', nickname: 'A', image: '' },
              },
            ],
            cursor: '',
            has_more: false,
          };
        }
        if (uri.includes('note/liked')) {
          return {
            users: [{ user_id: 'uA', nickname: 'A', image: '', followed: true }],
            cursor: '',
            has_more: false,
          };
        }
        return { users: [], cursor: '', has_more: false };
      }) as unknown as XhsClientLike['get'],
    };

    const result = await fetchInteractions(
      client,
      makeLimiter(),
      { noteId: 'n1', xsecToken: 't' },
      ['comment', 'like'],
    );

    const u = result.users.get('uA');
    expect(u).toBeDefined();
    expect(new Set(u?.types)).toEqual(new Set(['comment', 'like']));
    expect(u?.followedBlogger).toBe(true);
    expect(u?.commentText).toBe('好棒');
  });
});

describe('fetchInteractions — 错误中断与部分结果', () => {
  it('401 中途抛出 → 返回已抓部分 + abortReason=auth_error', async () => {
    let calls = 0;
    const client: XhsClientLike = {
      get: vi.fn(async () => {
        calls++;
        if (calls === 1) {
          return {
            comments: [
              {
                id: 'c1',
                content: '正常',
                create_time: 1,
                user_info: { user_id: 'u1', nickname: '', image: '' },
              },
            ],
            cursor: 'next',
            has_more: true,
          };
        }
        throw new XhsAuthError();
      }) as unknown as XhsClientLike['get'],
    };

    const result = await fetchInteractions(
      client,
      makeLimiter(),
      { noteId: 'n1', xsecToken: 't' },
      ['comment'],
    );

    expect(result.users.size).toBe(1); // 第一页抓到的
    expect(result.abortReason).toBe('auth_error');
    expect(result.partial).toBe(true);
  });

  it('461 中途抛出 → abortReason=risk_control', async () => {
    const client: XhsClientLike = {
      get: vi.fn(async () => {
        throw new XhsRiskControlError();
      }) as unknown as XhsClientLike['get'],
    };

    const result = await fetchInteractions(
      client,
      makeLimiter(),
      { noteId: 'n1', xsecToken: 't' },
      ['comment'],
    );

    expect(result.abortReason).toBe('risk_control');
    expect(result.users.size).toBe(0);
  });

  it('单会话上限触发 → abortReason=pool_cap', async () => {
    // cap=3，第一页返回 5 个用户必然触发 cap
    const client: XhsClientLike = {
      get: vi.fn(async () => ({
        comments: Array.from({ length: 5 }).map((_, i) => ({
          id: `c${i}`,
          content: `x${i}`,
          create_time: i,
          user_info: { user_id: `u${i}`, nickname: '', image: '' },
        })),
        cursor: 'next',
        has_more: true,
      })) as unknown as XhsClientLike['get'],
    };

    const result = await fetchInteractions(
      client,
      makeLimiter(3),
      { noteId: 'n1', xsecToken: 't' },
      ['comment'],
    );

    expect(result.abortReason).toBe('pool_cap');
    // 第一页已经抓了 5 个，退出时不再请求第二页
    expect(result.users.size).toBe(5);
  });
});

describe('fetchInteractions — follow 条件不触发粉丝列表接口', () => {
  it("conditions=['follow'] 只会走 followed 字段合并而不调任何接口", async () => {
    const spy = vi.fn(async () => ({ users: [], cursor: '', has_more: false }));
    const client: XhsClientLike = { get: spy as unknown as XhsClientLike['get'] };

    // 单选 follow：不应该调任何接口
    const result = await fetchInteractions(
      client,
      makeLimiter(),
      { noteId: 'n1', xsecToken: 't' },
      ['follow'],
    );

    expect(spy).not.toHaveBeenCalled();
    expect(result.users.size).toBe(0);
    expect(result.abortReason).toBeUndefined();
  });
});
