/**
 * 低质 / 高危用户评分
 *
 * 对应 requirements.md R10（低质量用户过滤）。
 * 权重表来自 design.md §2.4。
 *
 * 评分范围：[0, 1]，越高越可疑；≥ 阈值则剔除。
 * 默认阈值：0.6。
 */

// ============================================================================
// Types
// ============================================================================

/** 评分所需的最小用户画像字段（不依赖 InteractionRecord，便于复用） */
export interface ScorableUser {
  readonly userId: string;
  readonly userFollowsCount?: number;
  readonly userFansCount?: number;
  readonly commentText?: string;
}

export interface QualityScore {
  /** 总分 ∈ [0, 1]，越高越可疑 */
  readonly total: number;
  /** 可读中文理由，用于 UI 展示「为什么被过滤」 */
  readonly reasons: readonly string[];
}

export interface QualityFilters {
  readonly lowQualityCommentThreshold?: number;
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_QUALITY_THRESHOLD = 0.6;

// 权重表
const W_HIGH_FOLLOWS = 0.4;
const W_FARMER_RATIO = 0.3;
const W_COMMENT_TOO_SHORT = 0.25;
const W_EMOJI_ONLY = 0.3;
const W_DIGITS_ONLY = 0.3;
const W_TEMPLATE = 0.2;

// 阈值
const HIGH_FOLLOWS_LIMIT = 2000;
const FARMER_FANS_MAX = 5;
const FARMER_FOLLOWS_MIN = 500;
const COMMENT_MIN_LENGTH = 2;

/** 可扩展的模板评论正则集 */
export const COMMENT_TEMPLATE_PATTERNS: readonly RegExp[] = [
  /^冲冲冲+$/,
  /^抽我+$/,
  /^接好运$/,
  /^蹲+$/,
  /^蹲一个$/,
  /^in\b/i,
  /^我要\w?$/,
  /^想要$/,
  /^求中$/,
  /^大佬好$/,
  /^楼主好$/,
  /^参与$/,
  /^蹲蹲$/,
  /^来了$/,
  /^冲$/,
  /^dd$/i,
];

const EMOJI_OR_PUNCT_ONLY = /^[\p{Extended_Pictographic}\p{P}\s]+$/u;
const DIGITS_ONLY = /^\d+$/;

// ============================================================================
// Public API
// ============================================================================

export function scoreUser(u: ScorableUser): QualityScore {
  let score = 0;
  const reasons: string[] = [];

  // ---- 账号维度 ----
  if (typeof u.userFollowsCount === 'number') {
    if (u.userFollowsCount > HIGH_FOLLOWS_LIMIT) {
      score += W_HIGH_FOLLOWS;
      reasons.push(`关注数过高（${u.userFollowsCount}），疑似专职抽奖号`);
    }

    if (
      typeof u.userFansCount === 'number' &&
      u.userFansCount < FARMER_FANS_MAX &&
      u.userFollowsCount > FARMER_FOLLOWS_MIN
    ) {
      score += W_FARMER_RATIO;
      reasons.push(`关注多（${u.userFollowsCount}）但粉丝少（${u.userFansCount}），典型羊毛号特征`);
    }
  }

  // ---- 评论维度 ----
  if (typeof u.commentText === 'string') {
    const text = u.commentText.trim();

    if (text.length > 0 && text.length <= COMMENT_MIN_LENGTH) {
      score += W_COMMENT_TOO_SHORT;
      reasons.push(`评论过短（${text.length} 字）`);
    }

    if (text.length > 0 && EMOJI_OR_PUNCT_ONLY.test(text)) {
      score += W_EMOJI_ONLY;
      reasons.push('评论仅含表情或标点');
    }

    if (DIGITS_ONLY.test(text)) {
      score += W_DIGITS_ONLY;
      reasons.push(`评论仅含数字（${text}）`);
    }

    if (COMMENT_TEMPLATE_PATTERNS.some((p) => p.test(text))) {
      score += W_TEMPLATE;
      reasons.push('评论为常见抽奖模板话');
    }
  }

  return {
    total: Math.min(score, 1),
    reasons,
  };
}

export function passesQualityFilter(user: ScorableUser, filters: QualityFilters): boolean {
  const threshold = filters.lowQualityCommentThreshold ?? DEFAULT_QUALITY_THRESHOLD;
  // 阈值 >= 1 语义 = 关闭过滤（所有用户通过）
  if (threshold >= 1) return true;
  const { total } = scoreUser(user);
  return total < threshold;
}
