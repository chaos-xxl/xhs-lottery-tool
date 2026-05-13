/**
 * RateLimiter 单元测试（假时钟）
 *
 * 验证：
 *   - 两次 run 之间强制 ≥ minInterval 等待（R3.1）
 *   - 并发提交多个 fn 严格串行（R3.2）
 *   - 连续两次 461 触发 1 小时冷却（R3.4），第三次调用立即 reject
 *   - 单会话累计条数到达上限时 shouldStopForSessionCap() 返回 true（R3.3）
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { POOL_CAPPED_SIGNAL, RateLimiter } from './rate-limiter';
import { XhsRiskControlError } from './types';

// ============================================================================
// 假时钟与假 sleep
// ============================================================================

class FakeClock {
  private current = 1_700_000_000_000;
  now = (): number => this.current;
  advance(ms: number): void {
    this.current += ms;
  }
}

interface HarnessOpts {
  minIntervalMs?: number;
  cooldownMs?: number;
  consecutive461Limit?: number;
  itemCapPerSession?: number;
  fixedJitter?: number;
}

function makeHarness(opts: HarnessOpts = {}): {
  clock: FakeClock;
  limiter: RateLimiter;
  sleepCalls: number[];
} {
  const clock = new FakeClock();
  const sleepCalls: number[] = [];
  const limiter = new RateLimiter({
    now: clock.now,
    sleep: async (ms: number) => {
      sleepCalls.push(ms);
      clock.advance(ms);
    },
    randomJitter: () => opts.fixedJitter ?? 0, // 默认抖动 0，可预期
    minIntervalMs: opts.minIntervalMs ?? 1500,
    cooldownMs: opts.cooldownMs ?? 60 * 60 * 1000,
    consecutive461Limit: opts.consecutive461Limit ?? 2,
    itemCapPerSession: opts.itemCapPerSession ?? 1000,
  });
  return { clock, limiter, sleepCalls };
}

// ============================================================================
// Tests
// ============================================================================

describe('RateLimiter — 请求间隔（R3.1）', () => {
  it('首次请求不等待', async () => {
    const { limiter, sleepCalls } = makeHarness();
    await limiter.run(async () => 'ok');
    expect(sleepCalls).toHaveLength(0);
  });

  it('第二次请求前需要等足 minInterval + JITTER_MIN_MS', async () => {
    const { limiter, sleepCalls } = makeHarness({ fixedJitter: 0 });
    await limiter.run(async () => 'a');
    await limiter.run(async () => 'b');
    // 因为 fakeClock 只在 sleep 里推进，所以 sleep 被调用一次且值 = minInterval + jitterMin(300) = 1800
    expect(sleepCalls).toHaveLength(1);
    expect(sleepCalls[0]).toBe(1800);
  });

  it('抖动上限为 JITTER_MAX_MS(800)', async () => {
    const { limiter, sleepCalls } = makeHarness({ fixedJitter: 1 });
    await limiter.run(async () => 'a');
    await limiter.run(async () => 'b');
    // jitter = 300 + 1 * (800 - 300) = 800
    expect(sleepCalls[0]).toBe(2300);
  });

  it('距离上次已经超过 minInterval + jitter 时不再等待', async () => {
    const { clock, limiter, sleepCalls } = makeHarness({ fixedJitter: 0 });
    await limiter.run(async () => 'a');
    clock.advance(5000); // 手动推进 5s
    await limiter.run(async () => 'b');
    expect(sleepCalls).toHaveLength(0); // 无需额外等待
  });
});

describe('RateLimiter — 串行化（R3.2）', () => {
  it('并发提交的多个 fn 严格按提交顺序执行', async () => {
    const { limiter } = makeHarness({ fixedJitter: 0 });
    const order: number[] = [];

    const promises = [
      limiter.run(async () => {
        order.push(1);
        return 1;
      }),
      limiter.run(async () => {
        order.push(2);
        return 2;
      }),
      limiter.run(async () => {
        order.push(3);
        return 3;
      }),
    ];

    await Promise.all(promises);
    expect(order).toEqual([1, 2, 3]);
  });

  it('队列中任一任务抛错不会阻塞后续任务', async () => {
    const { limiter } = makeHarness({ fixedJitter: 0 });

    const p1 = limiter.run<string>(async () => {
      throw new Error('boom');
    });
    const p2 = limiter.run(async () => 'ok');

    await expect(p1).rejects.toThrow('boom');
    await expect(p2).resolves.toBe('ok');
  });
});

describe('RateLimiter — 461 冷却（R3.4）', () => {
  it('连续两次 XhsRiskControlError 触发 1 小时冷却', async () => {
    const { limiter } = makeHarness({ fixedJitter: 0 });

    await expect(
      limiter.run(async () => {
        throw new XhsRiskControlError();
      }),
    ).rejects.toThrow(XhsRiskControlError);

    await expect(
      limiter.run(async () => {
        throw new XhsRiskControlError();
      }),
    ).rejects.toThrow(XhsRiskControlError);

    // 第三次立即被 cooldown 拒绝
    await expect(limiter.run(async () => 'should-not-run')).rejects.toThrow(/冷却期/);

    const state = limiter.getCooldownState();
    expect(state.inCooldown).toBe(true);
    expect(state.remainingMs).toBeGreaterThan(60 * 59 * 1000);
    expect(state.remainingMs).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('冷却时间过后允许再次调用', async () => {
    const { clock, limiter } = makeHarness({ fixedJitter: 0, cooldownMs: 1000 });
    await expect(
      limiter.run(async () => {
        throw new XhsRiskControlError();
      }),
    ).rejects.toThrow();
    await expect(
      limiter.run(async () => {
        throw new XhsRiskControlError();
      }),
    ).rejects.toThrow();

    expect(limiter.getCooldownState().inCooldown).toBe(true);
    clock.advance(1001);
    expect(limiter.getCooldownState().inCooldown).toBe(false);

    const ok = await limiter.run(async () => 'revived');
    expect(ok).toBe('revived');
  });

  it('中间穿插一次成功会把 461 计数重置', async () => {
    const { limiter } = makeHarness({ fixedJitter: 0 });

    await expect(
      limiter.run(async () => {
        throw new XhsRiskControlError();
      }),
    ).rejects.toThrow();

    await limiter.run(async () => 'ok'); // reset counter

    await expect(
      limiter.run(async () => {
        throw new XhsRiskControlError();
      }),
    ).rejects.toThrow();

    // 此时累计 461 = 1（因为中间成功过一次），不应该进入冷却
    expect(limiter.getCooldownState().inCooldown).toBe(false);
  });

  it('recordRiskControl() 手动记账也能触发冷却', () => {
    const { limiter } = makeHarness();
    limiter.recordRiskControl();
    limiter.recordRiskControl();
    expect(limiter.getCooldownState().inCooldown).toBe(true);
  });
});

describe('RateLimiter — 单会话上限（R3.3）', () => {
  it('到达 itemCapPerSession 后 shouldStopForSessionCap 返回 true', () => {
    const { limiter } = makeHarness({ itemCapPerSession: 100 });
    limiter.addToSession(40);
    expect(limiter.shouldStopForSessionCap()).toBe(false);
    limiter.addToSession(70);
    expect(limiter.shouldStopForSessionCap()).toBe(true);
  });

  it('resetSession 清零累计条数', () => {
    const { limiter } = makeHarness({ itemCapPerSession: 100 });
    limiter.addToSession(100);
    expect(limiter.shouldStopForSessionCap()).toBe(true);
    limiter.resetSession();
    expect(limiter.shouldStopForSessionCap()).toBe(false);
  });

  it('POOL_CAPPED_SIGNAL 是稳定的 Symbol 可被上层识别', () => {
    expect(typeof POOL_CAPPED_SIGNAL).toBe('symbol');
  });
});
