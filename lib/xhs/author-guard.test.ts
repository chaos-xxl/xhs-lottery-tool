/**
 * Author Guard 单元测试（mock XhsClient）
 *
 * 验证：
 *   - 作者一致 → ok（R1.1）
 *   - 作者不一致 → ok=false, reason=not_self_post（R1.2）
 *   - Cookie 401 → ok=false, reason=cookie_expired（向上透传，不模糊通过）
 *   - 461 → ok=false, reason=risk_control_triggered
 *   - 响应异常 → ok=false, reason=fetch_failed
 *   - ensureSelfPostOrThrow 在作者不一致时抛 AuthorGuardError
 */

import { describe, expect, it, vi } from 'vitest';
import { AuthorGuardError, ensureSelfPost, ensureSelfPostOrThrow } from './author-guard';
import {
  type NoteFeedResponse,
  XhsAuthError,
  type XhsClientLike,
  XhsRiskControlError,
} from './types';

const VALID_FEED = (authorId: string): NoteFeedResponse => ({
  note: {
    id: 'note_test_001',
    title: '这是我自己的帖子',
    user: { user_id: authorId, nickname: 'me' },
    time: 1_700_000_000_000,
  },
});

function makeClient(impl: (uri: string, params?: Record<string, string>) => Promise<unknown>): {
  client: XhsClientLike;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(impl);
  return {
    client: { get: spy as unknown as XhsClientLike['get'] },
    spy,
  };
}

describe('ensureSelfPost — 作者一致', () => {
  it('帖子作者 user_id 等于当前账号 → ok=true，返回元信息', async () => {
    const { client } = makeClient(async () => VALID_FEED('me_user_001'));

    const result = await ensureSelfPost(client, {
      noteId: 'note_test_001',
      xsecToken: 'token',
      currentUserId: 'me_user_001',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.authorId).toBe('me_user_001');
      expect(result.noteTitle).toBe('这是我自己的帖子');
      expect(result.publishedAt).toBe(1_700_000_000_000);
    }
  });

  it('传递了正确的 xsec_token / xsec_source 到接口参数', async () => {
    const { client, spy } = makeClient(async () => VALID_FEED('me'));

    await ensureSelfPost(client, {
      noteId: 'note1',
      xsecToken: 'my-token',
      currentUserId: 'me',
      xsecSource: 'app_share',
    });

    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('feed'),
      expect.objectContaining({
        source_note_id: 'note1',
        xsec_token: 'my-token',
        xsec_source: 'app_share',
      }),
    );
  });
});

describe('ensureSelfPost — 作者不一致（R1.2）', () => {
  it('帖子作者 !== 当前账号 → ok=false, reason=not_self_post', async () => {
    const { client } = makeClient(async () => VALID_FEED('someone_else'));

    const result = await ensureSelfPost(client, {
      noteId: 'note_test_001',
      xsecToken: 'token',
      currentUserId: 'me_user_001',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_self_post');
      expect(result.message).toContain('自己发布');
    }
  });
});

describe('ensureSelfPost — 接口错误透传（R1.4 / R3.5）', () => {
  it('Cookie 401 → reason=cookie_expired，原错误被透传', async () => {
    const { client } = makeClient(async () => {
      throw new XhsAuthError('web_session 过期');
    });

    const result = await ensureSelfPost(client, {
      noteId: 'n1',
      xsecToken: 't',
      currentUserId: 'me',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('cookie_expired');
      expect(result.error).toBeInstanceOf(XhsAuthError);
    }
  });

  it('461 → reason=risk_control_triggered', async () => {
    const { client } = makeClient(async () => {
      throw new XhsRiskControlError();
    });

    const result = await ensureSelfPost(client, {
      noteId: 'n1',
      xsecToken: 't',
      currentUserId: 'me',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('risk_control_triggered');
      expect(result.error).toBeInstanceOf(XhsRiskControlError);
    }
  });

  it('普通异常 → reason=fetch_failed', async () => {
    const { client } = makeClient(async () => {
      throw new Error('network timeout');
    });

    const result = await ensureSelfPost(client, {
      noteId: 'n1',
      xsecToken: 't',
      currentUserId: 'me',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('fetch_failed');
    }
  });

  it('响应缺少 note.user.user_id → reason=fetch_failed', async () => {
    const { client } = makeClient(async () => ({
      note: { id: 'x', title: '', user: {}, time: 0 },
    }));

    const result = await ensureSelfPost(client, {
      noteId: 'n1',
      xsecToken: 't',
      currentUserId: 'me',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('fetch_failed');
    }
  });
});

describe('ensureSelfPostOrThrow — 强制抛出版', () => {
  it('作者一致 → 返回 ok 对象', async () => {
    const { client } = makeClient(async () => VALID_FEED('me'));

    const result = await ensureSelfPostOrThrow(client, {
      noteId: 'n1',
      xsecToken: 't',
      currentUserId: 'me',
    });

    expect(result.authorId).toBe('me');
  });

  it('作者不一致 → 抛 AuthorGuardError', async () => {
    const { client } = makeClient(async () => VALID_FEED('someone_else'));

    await expect(
      ensureSelfPostOrThrow(client, {
        noteId: 'n1',
        xsecToken: 't',
        currentUserId: 'me',
      }),
    ).rejects.toThrow(AuthorGuardError);
  });

  it('Cookie 401 → 透传 XhsAuthError（不是 AuthorGuardError）', async () => {
    const { client } = makeClient(async () => {
      throw new XhsAuthError();
    });

    await expect(
      ensureSelfPostOrThrow(client, {
        noteId: 'n1',
        xsecToken: 't',
        currentUserId: 'me',
      }),
    ).rejects.toThrow(XhsAuthError);
  });
});
