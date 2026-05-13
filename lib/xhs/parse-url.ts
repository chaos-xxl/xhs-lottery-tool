/**
 * 小红书帖子链接解析
 *
 * 对应 requirements.md R6（小红书链接解析）。
 *
 * 支持的链接形态：
 *   - https://www.xiaohongshu.com/explore/{noteId}?xsec_token=...&xsec_source=...
 *   - https://www.xiaohongshu.com/discovery/item/{noteId}?xsec_token=...
 *   - http://xhslink.com/a/* 短链 → HEAD 跟随 302 获取真实 URL 再解析
 *
 * 缺少 note_id 或 xsec_token 时抛 LinkParseError（R6.3）。
 */

// ============================================================================
// Types & Errors
// ============================================================================

export interface ParsedPostLink {
  readonly noteId: string;
  readonly xsecToken: string;
  readonly xsecSource: string;
  /** 解析后的最终 URL（含展开后的短链） */
  readonly resolvedUrl: string;
  /** 原始输入 URL */
  readonly rawUrl: string;
}

export class LinkParseError extends Error {
  readonly code = 'link_parse_error' as const;

  constructor(
    message: string,
    readonly rawUrl: string,
  ) {
    super(message);
    this.name = 'LinkParseError';
  }
}

// ============================================================================
// 配置
// ============================================================================

const XHS_MAIN_HOSTS = new Set(['www.xiaohongshu.com', 'xiaohongshu.com']);
const XHS_SHORT_HOST = 'xhslink.com';

/** Fetch 抽象：允许测试注入 mock */
export interface LinkFetcher {
  head(url: string): Promise<{ status: number; location?: string }>;
}

const defaultFetcher: LinkFetcher = {
  async head(url) {
    const res = await fetch(url, { method: 'HEAD', redirect: 'manual' });
    return {
      status: res.status,
      location: res.headers.get('location') ?? undefined,
    };
  },
};

// ============================================================================
// Implementation
// ============================================================================

/**
 * 解析小红书帖子链接。短链会被自动展开。
 */
export async function parseXhsUrl(
  rawUrl: string,
  fetcher: LinkFetcher = defaultFetcher,
): Promise<ParsedPostLink> {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    throw new LinkParseError('链接为空', rawUrl);
  }

  let targetUrl = trimmed;

  // 1. 短链展开：xhslink.com/a/xxxx → 真实 URL
  if (isShortLink(targetUrl)) {
    targetUrl = await expandShortLink(targetUrl, fetcher);
  }

  // 2. 校验域名
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new LinkParseError(`链接格式错误：${targetUrl}`, rawUrl);
  }

  if (!XHS_MAIN_HOSTS.has(parsed.host)) {
    throw new LinkParseError(`不支持的域名：${parsed.host}（只允许 xiaohongshu.com）`, rawUrl);
  }

  // 3. 提取 note_id（path 最后一段）
  const noteId = extractNoteId(parsed);
  if (!noteId) {
    throw new LinkParseError('链接缺少必要字段：note_id', rawUrl);
  }

  // 4. 提取 xsec_token（R6.3：缺 token 直接拒绝）
  const xsecToken = parsed.searchParams.get('xsec_token') ?? '';
  if (!xsecToken) {
    throw new LinkParseError(
      '链接缺少必要字段：xsec_token。请直接从网页版地址栏复制完整 URL',
      rawUrl,
    );
  }

  const xsecSource = parsed.searchParams.get('xsec_source') ?? 'pc_feed';

  return {
    noteId,
    xsecToken,
    xsecSource,
    resolvedUrl: parsed.toString(),
    rawUrl,
  };
}

// ============================================================================
// Helpers
// ============================================================================

function isShortLink(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.host === XHS_SHORT_HOST;
  } catch {
    return false;
  }
}

async function expandShortLink(url: string, fetcher: LinkFetcher): Promise<string> {
  const res = await fetcher.head(url);
  if (res.status >= 300 && res.status < 400 && res.location) {
    return res.location;
  }
  throw new LinkParseError(`短链展开失败：HEAD 返回 ${res.status}，未获得 Location`, url);
}

function extractNoteId(url: URL): string | null {
  // 支持 /explore/{noteId}、/discovery/item/{noteId}
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const last = segments[segments.length - 1];
  // note_id 是 24 位十六进制（小红书约定），允许任意非空字符串以兼容格式演化
  if (!last || last.length < 6) return null;
  return last;
}
