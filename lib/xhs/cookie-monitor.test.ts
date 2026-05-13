/**
 * CookieMonitor 单元测试
 *
 * 验证：
 *   - 各状态转换路径（R2.3 / R2.4）
 *   - 24 小时冷却期内 probe 不再打真实请求（R2.5）
 *   - onChange 订阅在状态变化时触发
 *   - expiring_soon 判定（距过期 < 3 天）
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CookieMonitor } from './cookie-monitor';
import {
  type SelfInfoResponse,
  XhsAuthError,
  type XhsClientLike,
  XhsRiskControlError,
} from './types';

class FakeClock {
  private current = 1_700_000_000_000;
  now = (): number => this.current;
  advance(ms: number): void {
    this.current += ms;
  }
}

function makeClient(impl: () => Promise<SelfInfoResponse>): {
  client: XhsClientLike;
  spy: ReturnType<typeof vi.fn>;
} {
  const spy = vi.fn(impl);
  return {
    client: { get: spy as unknown as XhsClientLike['get'] },
    spy,
  };
}

const VALID_SELF_INFO: SelfInfoResponse = {
  user_id: 'me_001',
  nickname: 'me',
  account_status: 'normal',
};

let clock: FakeClock;

beforeEach(() => {
  clock = new FakeClock();
});

describe('CookieMonitor — 正常流程', () => {
  it('probe 成功 → status=healthy，记录 accountUserId', async () => {
    const { client } = makeClient(async () => VALID_SELF_INFO);
    const monitor = new CookieMonitor(client, { now: clock.now });

    const meta = await monitor.probe();

    expect(meta.status).toBe('healthy');
    expect(meta.accountUserId).toBe('me_001');
    expect(meta.lastProbedAt).toBe(clock.now());
  });

  it('未探测过时 status=unknown', () => {
    const { client } = makeClient(async () => VALID_SELF_INFO);
    const monitor = new CookieMonitor(client, { now: clock.now });
    expect(monitor.getStatus().status).toBe('unknown');
  });
});

describe('CookieMonitor — 状态转换（R2.3 / R2.4）', () => {
  it('接口抛 XhsAuthError → status=expired', async () => {
    const { client } = makeClient(async () => {
      throw new XhsAuthError();
    });
    const monitor = new CookieMonitor(client, { now: clock.now });

    const meta = await monitor.probe();
    expect(meta.status).toBe('expired');
  });

  it('接口抛 XhsRiskControlError → status=challenge_required + 24h 冷却', async () => {
    const { client } = makeClient(async () => {
      throw new XhsRiskControlError();
    });
    const monitor = new CookieMonitor(client, { now: clock.now });

    const meta = await monitor.probe();
    expect(meta.status).toBe('challenge_required');
    expect(meta.cooldownUntil).toBe(clock.now() + 24 * 60 * 60 * 1000);
  });

  it('未知错误 → status=unknown', async () => {
    const { client } = makeClient(async () => {
      throw new Error('network flaky');
    });
    const monitor = new CookieMonitor(client, { now: clock.now });

    const meta = await monitor.probe();
    expect(meta.status).toBe('unknown');
  });

  it('account_status = "limited" → status=expired', async () => {
    const { client } = makeClient(async () => ({
      user_id: 'me',
      nickname: 'me',
      account_status: 'limited',
    }));
    const monitor = new CookieMonitor(client, { now: clock.now });

    const meta = await monitor.probe();
    expect(meta.status).toBe('expired');
  });
});

describe('CookieMonitor — 冷却期内不打接口（R2.5）', () => {
  it('challenge_required 冷却期内，probe 直接返回缓存，不触发真实调用', async () => {
    const { client, spy } = makeClient(async () => {
      throw new XhsRiskControlError();
    });
    const monitor = new CookieMonitor(client, {
      now: clock.now,
      challengeCooldownMs: 5000,
    });

    await monitor.probe(); // 第一次触发冷却
    expect(spy).toHaveBeenCalledTimes(1);

    await monitor.probe(); // 冷却期内
    expect(spy).toHaveBeenCalledTimes(1); // 没打真实接口

    clock.advance(5001);

    // 冷却过期后，恢复成功
    spy.mockImplementation(async () => VALID_SELF_INFO);
    const meta = await monitor.probe();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(meta.status).toBe('healthy');
  });
});

describe('CookieMonitor — expiring_soon 判定', () => {
  it('Cookie 过期时间距当前 < 3 天 → status=expiring_soon', async () => {
    const { client } = makeClient(async () => VALID_SELF_INFO);
    const monitor = new CookieMonitor(client, { now: clock.now });

    const twoDaysLater = clock.now() + 2 * 24 * 60 * 60 * 1000;
    const meta = await monitor.probe(twoDaysLater);

    expect(meta.status).toBe('expiring_soon');
    expect(meta.expiresInMs).toBeCloseTo(2 * 24 * 60 * 60 * 1000, -5);
  });

  it('Cookie 过期时间距当前 > 3 天 → status=healthy', async () => {
    const { client } = makeClient(async () => VALID_SELF_INFO);
    const monitor = new CookieMonitor(client, { now: clock.now });

    const tenDaysLater = clock.now() + 10 * 24 * 60 * 60 * 1000;
    const meta = await monitor.probe(tenDaysLater);

    expect(meta.status).toBe('healthy');
  });

  it('Cookie 过期时间已过 → status=expired', async () => {
    const { client } = makeClient(async () => VALID_SELF_INFO);
    const monitor = new CookieMonitor(client, { now: clock.now });

    const past = clock.now() - 1000;
    const meta = await monitor.probe(past);

    expect(meta.status).toBe('expired');
  });
});

describe('CookieMonitor — onChange 订阅', () => {
  it('状态变化时触发 listener', async () => {
    const { client } = makeClient(async () => VALID_SELF_INFO);
    const monitor = new CookieMonitor(client, { now: clock.now });

    const received: string[] = [];
    const unsubscribe = monitor.onChange((meta) => received.push(meta.status));

    await monitor.probe();
    expect(received).toContain('healthy');

    unsubscribe();
    received.length = 0;

    // 订阅取消后不再收到
    await monitor.probe();
    expect(received).toHaveLength(0);
  });

  it('同状态重复 probe 不重复触发 listener', async () => {
    const { client } = makeClient(async () => VALID_SELF_INFO);
    const monitor = new CookieMonitor(client, { now: clock.now });

    const spy = vi.fn();
    monitor.onChange(spy);

    await monitor.probe();
    await monitor.probe();
    await monitor.probe();

    // 第一次 unknown → healthy 触发一次；后续状态未变化不触发
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('listener 抛错不影响其他 listener', async () => {
    const { client } = makeClient(async () => VALID_SELF_INFO);
    const monitor = new CookieMonitor(client, { now: clock.now });

    const good = vi.fn();
    monitor.onChange(() => {
      throw new Error('bad listener');
    });
    monitor.onChange(good);

    await monitor.probe();
    expect(good).toHaveBeenCalled();
  });
});

describe('CookieMonitor — 外部记账', () => {
  it('recordRiskControl 等效于 probe 收到 461', () => {
    const { client } = makeClient(async () => VALID_SELF_INFO);
    const monitor = new CookieMonitor(client, { now: clock.now });

    monitor.recordRiskControl();
    expect(monitor.getStatus().status).toBe('challenge_required');
    expect(monitor.getStatus().cooldownUntil).toBe(clock.now() + 24 * 60 * 60 * 1000);
  });

  it('recordAuthFailure 等效于 probe 收到 401', () => {
    const { client } = makeClient(async () => VALID_SELF_INFO);
    const monitor = new CookieMonitor(client, { now: clock.now });

    monitor.recordAuthFailure();
    expect(monitor.getStatus().status).toBe('expired');
  });
});
