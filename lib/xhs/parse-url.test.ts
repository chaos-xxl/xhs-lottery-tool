/**
 * parse-url 单元测试
 *
 * 验证：
 *   - 三种链接形态的正样本解析（R6.1 / R6.2）
 *   - 缺字段 / 非法域名 / 非法格式的负样本（R6.3）
 *   - 短链展开路径（R6.1）
 */

import { describe, expect, it, vi } from 'vitest';
import { type LinkFetcher, LinkParseError, parseXhsUrl } from './parse-url';

function makeFetcher(impl: (url: string) => ReturnType<LinkFetcher['head']>): LinkFetcher {
  return { head: vi.fn(impl) as unknown as LinkFetcher['head'] };
}

describe('parseXhsUrl — 正样本', () => {
  it('/explore/{noteId} 链接 + 完整 query 能解析', async () => {
    const rawUrl =
      'https://www.xiaohongshu.com/explore/6520abc123def456789000?xsec_token=AB-xxx&xsec_source=pc_feed';

    const result = await parseXhsUrl(rawUrl);

    expect(result.noteId).toBe('6520abc123def456789000');
    expect(result.xsecToken).toBe('AB-xxx');
    expect(result.xsecSource).toBe('pc_feed');
    expect(result.rawUrl).toBe(rawUrl);
  });

  it('/discovery/item/{noteId} 链接能解析', async () => {
    const rawUrl = 'https://www.xiaohongshu.com/discovery/item/6520deadbeef?xsec_token=XYZ';

    const result = await parseXhsUrl(rawUrl);

    expect(result.noteId).toBe('6520deadbeef');
    expect(result.xsecToken).toBe('XYZ');
    expect(result.xsecSource).toBe('pc_feed'); // 默认值
  });

  it('/explore/{noteId} 但无 xsec_source 时使用默认值 pc_feed', async () => {
    const result = await parseXhsUrl('https://www.xiaohongshu.com/explore/abc123456?xsec_token=T');
    expect(result.xsecSource).toBe('pc_feed');
  });

  it('xhslink.com 短链 HEAD 跟随 302 拿 Location 再解析', async () => {
    const realUrl =
      'https://www.xiaohongshu.com/explore/6520real?xsec_token=FROM_SHORT&xsec_source=app_share';
    const fetcher = makeFetcher(async () => ({ status: 302, location: realUrl }));

    const result = await parseXhsUrl('https://xhslink.com/a/abc123', fetcher);

    expect(result.noteId).toBe('6520real');
    expect(result.xsecToken).toBe('FROM_SHORT');
    expect(result.xsecSource).toBe('app_share');
    expect(result.resolvedUrl).toContain('xiaohongshu.com');
    expect(fetcher.head).toHaveBeenCalledWith('https://xhslink.com/a/abc123');
  });

  it('rawUrl 带首尾空白会被 trim', async () => {
    const result = await parseXhsUrl('  https://www.xiaohongshu.com/explore/abc123?xsec_token=T  ');
    expect(result.noteId).toBe('abc123');
  });
});

describe('parseXhsUrl — 负样本（R6.3）', () => {
  it('空字符串 → LinkParseError', async () => {
    await expect(parseXhsUrl('')).rejects.toThrow(LinkParseError);
  });

  it('非法 URL 格式 → LinkParseError', async () => {
    await expect(parseXhsUrl('not a url')).rejects.toThrow(LinkParseError);
  });

  it('非 xiaohongshu.com 域名 → LinkParseError', async () => {
    await expect(parseXhsUrl('https://example.com/explore/abc?xsec_token=T')).rejects.toThrow(
      /不支持的域名/,
    );
  });

  it('缺 xsec_token → LinkParseError 提示明确', async () => {
    try {
      await parseXhsUrl('https://www.xiaohongshu.com/explore/abc123');
      expect.fail('应该抛错');
    } catch (err) {
      expect(err).toBeInstanceOf(LinkParseError);
      expect((err as LinkParseError).message).toContain('xsec_token');
    }
  });

  it('xsec_token 为空字符串 → LinkParseError', async () => {
    await expect(
      parseXhsUrl('https://www.xiaohongshu.com/explore/abc123?xsec_token='),
    ).rejects.toThrow(/xsec_token/);
  });

  it('note_id 长度 < 6 → LinkParseError', async () => {
    await expect(parseXhsUrl('https://www.xiaohongshu.com/explore/x?xsec_token=T')).rejects.toThrow(
      /note_id/,
    );
  });

  it('path 为空 → LinkParseError', async () => {
    await expect(parseXhsUrl('https://www.xiaohongshu.com/?xsec_token=T')).rejects.toThrow(
      /note_id/,
    );
  });

  it('短链 HEAD 没有返回 Location → LinkParseError', async () => {
    const fetcher = makeFetcher(async () => ({ status: 200 }));

    await expect(parseXhsUrl('https://xhslink.com/a/xxx', fetcher)).rejects.toThrow(/短链展开失败/);
  });

  it('短链 HEAD 返回非 3xx → LinkParseError', async () => {
    const fetcher = makeFetcher(async () => ({ status: 404 }));

    await expect(parseXhsUrl('https://xhslink.com/a/xxx', fetcher)).rejects.toThrow(/短链展开失败/);
  });
});
