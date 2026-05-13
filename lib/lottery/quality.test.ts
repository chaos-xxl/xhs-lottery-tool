import { describe, expect, it } from 'vitest';
import {
  COMMENT_TEMPLATE_PATTERNS,
  DEFAULT_QUALITY_THRESHOLD,
  passesQualityFilter,
  scoreUser,
} from './quality';

describe('scoreUser — 账号维度', () => {
  it('关注数 > 2000 → +0.40', () => {
    const s = scoreUser({ userId: 'u', userFollowsCount: 3000 });
    expect(s.total).toBeCloseTo(0.4, 2);
    expect(s.reasons.some((r) => r.includes('关注数过高'))).toBe(true);
  });

  it('粉丝 < 5 + 关注 > 500 → +0.30（羊毛号特征）', () => {
    const s = scoreUser({ userId: 'u', userFollowsCount: 600, userFansCount: 2 });
    expect(s.total).toBeCloseTo(0.3, 2);
    expect(s.reasons.some((r) => r.includes('羊毛号'))).toBe(true);
  });

  it('关注数字段缺失不加分也不报错', () => {
    const s = scoreUser({ userId: 'u' });
    expect(s.total).toBe(0);
    expect(s.reasons).toEqual([]);
  });

  it('正常账号（关注 500、粉丝 200）不加分', () => {
    const s = scoreUser({ userId: 'u', userFollowsCount: 500, userFansCount: 200 });
    expect(s.total).toBe(0);
  });
});

describe('scoreUser — 评论维度', () => {
  it('纯表情评论 → +0.30', () => {
    const s = scoreUser({
      userId: 'u',
      commentText: '🎁🎁🎁',
    });
    expect(s.total).toBeGreaterThanOrEqual(0.3);
    expect(s.reasons.some((r) => r.includes('表情'))).toBe(true);
  });

  it('纯数字评论（111、666）→ +0.30', () => {
    const s = scoreUser({ userId: 'u', commentText: '666' });
    expect(s.total).toBeGreaterThanOrEqual(0.3);
    expect(s.reasons.some((r) => r.includes('数字'))).toBe(true);
  });

  it('过短评论（≤ 2 字）→ +0.25', () => {
    const s = scoreUser({ userId: 'u', commentText: '嗯' });
    expect(s.total).toBeGreaterThanOrEqual(0.25);
    expect(s.reasons.some((r) => r.includes('过短'))).toBe(true);
  });

  it('模板套话（蹲、冲冲冲）→ +0.20', () => {
    for (const tpl of ['蹲一个', '冲冲冲', '接好运', '抽我']) {
      const s = scoreUser({ userId: 'u', commentText: tpl });
      expect(s.total).toBeGreaterThanOrEqual(0.2);
    }
  });

  it('正常长评论 → 分低（< 0.3）', () => {
    const s = scoreUser({
      userId: 'u',
      userFollowsCount: 300,
      userFansCount: 100,
      commentText: '楼主拍的这组街拍色调真的很有电影感，最喜欢第三张，光比处理得特别到位',
    });
    expect(s.total).toBeLessThan(0.3);
  });
});

describe('scoreUser — 叠加与上限', () => {
  it('典型羊毛号：关注 3000 + 纯表情 + 粉丝 1 → total = 1（上限截断）', () => {
    const s = scoreUser({
      userId: 'u',
      userFollowsCount: 3000,
      userFansCount: 1,
      commentText: '🎁💰🎉',
    });
    expect(s.total).toBe(1);
    expect(s.reasons.length).toBeGreaterThanOrEqual(3);
  });

  it('reasons 列表是中文可读理由', () => {
    const s = scoreUser({
      userId: 'u',
      userFollowsCount: 3000,
      commentText: '666',
    });
    for (const r of s.reasons) {
      expect(r).toMatch(/[\u4e00-\u9fa5]/); // 至少包含中文字符
    }
  });
});

describe('passesQualityFilter — 阈值', () => {
  it('默认阈值 0.6，低于此值通过', () => {
    expect(DEFAULT_QUALITY_THRESHOLD).toBe(0.6);

    const u = { userId: 'u', commentText: '666' }; // 0.3
    expect(passesQualityFilter(u, {})).toBe(true);
  });

  it('高于或等于默认阈值 0.6 则剔除', () => {
    const u = {
      userId: 'u',
      userFollowsCount: 3000, // 0.4
      commentText: '666', // 0.3 → total 0.7
    };
    expect(passesQualityFilter(u, {})).toBe(false);
  });

  it('显式阈值 0.3 时更严格', () => {
    const u = { userId: 'u', commentText: '666' }; // 0.3
    expect(passesQualityFilter(u, { lowQualityCommentThreshold: 0.3 })).toBe(false);
  });

  it('阈值 1.0 时所有用户通过', () => {
    const u = {
      userId: 'u',
      userFollowsCount: 9999,
      userFansCount: 0,
      commentText: '🎁',
    };
    expect(passesQualityFilter(u, { lowQualityCommentThreshold: 1.0 })).toBe(true);
  });
});

describe('COMMENT_TEMPLATE_PATTERNS — 可扩展正则集', () => {
  it('导出的模板列表非空，便于未来扩充', () => {
    expect(COMMENT_TEMPLATE_PATTERNS.length).toBeGreaterThan(0);
  });
});
