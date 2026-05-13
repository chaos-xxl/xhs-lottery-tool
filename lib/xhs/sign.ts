/**
 * 小红书 Web 签名头生成（占位桩）
 *
 * ⚠️ 这是 Task 3.3 规划的占位实现，不是真正的签名算法。
 *
 * 设计意图：
 *   1. 提供稳定的 `sign()` 接口，让 `XhsClient` 可以先接入、跑通
 *   2. 实际 `computeXs`、`mrc`、`FIXED_B1` 的真实实现需要从社区库移植：
 *      - ReaJason/xhs (Python): https://github.com/ReaJason/xhs
 *      - NanmiCoder/MediaCrawler (Python): https://github.com/NanmiCoder/MediaCrawler
 *      - xuzuoyun/xhs-web-sign (JS): https://github.com/xuzuoyun/xhs-web-sign
 *   3. 真实算法会逆向 `x-s` 的 MD5+salt 计算，目前的实现无法通过小红书校验
 *
 * 升级 checklist（发现 461 时）：
 *   [ ] 抓 https://www.xiaohongshu.com 最新 js 文件，检查 window._webmsxyw 是否变化
 *   [ ] 对照 ReaJason/xhs 最近 commit，拉取最新 computeXs
 *   [ ] 更新 FIXED_B1 版本号（小红书 web 客户端版本）
 *   [ ] 跑 XhsClient 的集成测试验证
 */

import { createHash, randomBytes } from 'node:crypto';

// ============================================================================
// Types
// ============================================================================

export interface SignInput {
  /** API URI，例如 '/api/sns/web/v1/feed' */
  readonly uri: string;
  /** POST body；GET 时传 undefined */
  readonly data?: unknown;
  /** 从 cookie 中的 a1 字段 */
  readonly a1: string;
  /** 从 localStorage 的 b1（占位用固定常量） */
  readonly b1?: string;
}

export interface SignHeaders {
  readonly 'x-s': string;
  readonly 'x-t': string;
  readonly 'x-s-common': string;
  readonly 'x-b3-traceid': string;
}

// ============================================================================
// Constants
// ============================================================================

/**
 * 前端 localStorage 中 b1 的占位值。
 * 真实实现应该从社区库获取最新版本号。
 */
export const FIXED_B1 = 'placeholder_b1_needs_upgrade_from_community_lib';

/**
 * 签名算法标识。测试和 UI 可据此判断是「占位桩」还是「真实实现」。
 */
export const SIGN_IMPL_KIND: 'stub' | 'real' = 'stub';

// ============================================================================
// Stub implementation
// ============================================================================

/**
 * 生成 x-s/x-t/x-s-common/x-b3-traceid 签名头（占位桩）。
 *
 * 注意：stub 版本生成的签名不会被小红书接受；仅保证格式合法，可供：
 *   - XhsClient 的接口契约测试
 *   - Section 6/7 的集成/UI 开发时 mock 调用
 *   - 将 `SIGN_IMPL_KIND` 检查为 'real' 之前拒绝发起真实请求
 */
export function sign(input: SignInput): SignHeaders {
  const xt = Date.now().toString();
  const xs = computeXs(input.uri, input.data, xt, input.a1);
  const common = {
    s0: 5,
    x1: '3.7.x',
    x2: 'Mac OS',
    x3: 'xhs-pc-web',
    x5: input.a1,
    x6: xt,
    x7: xs,
    x8: input.b1 ?? FIXED_B1,
    x9: mrc(`${xt}${xs}${input.b1 ?? FIXED_B1}`),
    x10: 1,
  };
  return {
    'x-s': xs,
    'x-t': xt,
    'x-s-common': Buffer.from(JSON.stringify(common), 'utf8').toString('base64'),
    'x-b3-traceid': randomBytes(8).toString('hex'),
  };
}

/**
 * x-s 的占位实现：取 (uri, data, xt, a1) 的 SHA-256 前 32 字节。
 * 真实算法涉及 MD5 + 前端混淆 salt，需要从社区库移植。
 */
function computeXs(uri: string, data: unknown, xt: string, a1: string): string {
  const payload = JSON.stringify({ uri, data: data ?? null, xt, a1 });
  return createHash('sha256').update(payload).digest('hex').slice(0, 32);
}

/**
 * mrc 的占位实现：返回一个基于输入的稳定整数。
 */
function mrc(input: string): number {
  const digest = createHash('sha256').update(input).digest();
  return digest.readUInt32BE(0);
}

// ============================================================================
// Assertions
// ============================================================================

/**
 * 守护函数：在真实网络请求前调用，若仍是 stub 实现则拒绝发出。
 *
 * 这样可以保证「忘了移植签名算法」的情况下不会撞小红书线上风控。
 */
export function assertRealSignOrRefuse(): void {
  if (SIGN_IMPL_KIND === 'stub') {
    throw new Error(
      '签名算法仍是占位桩（stub）：请先从社区库移植 computeXs/mrc 到 lib/xhs/sign.ts，并把 SIGN_IMPL_KIND 改为 "real" 之后再发起真实请求。',
    );
  }
}
