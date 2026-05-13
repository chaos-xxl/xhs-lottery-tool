'use client';

/**
 * Cookie 健康度状态徽标（🟢🟡🔴 + 文案 + 跳转 /cookie）
 *
 * 对应 requirements.md R16。
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge } from './ui/badge';

type Status =
  | 'healthy'
  | 'expiring_soon'
  | 'expired'
  | 'challenge_required'
  | 'unknown'
  | 'unconfigured';

interface CookieStatusInfo {
  configured: boolean;
  status?: Status;
  accountUserId?: string | null;
  cooldownUntil?: number;
}

const LABEL: Record<
  Status,
  { text: string; variant: 'default' | 'secondary' | 'destructive' | 'outline'; dot: string }
> = {
  healthy: { text: 'Cookie 正常', variant: 'default', dot: 'bg-emerald-500' },
  expiring_soon: { text: '即将过期', variant: 'secondary', dot: 'bg-amber-500' },
  expired: { text: 'Cookie 已失效', variant: 'destructive', dot: 'bg-red-500' },
  challenge_required: { text: '触发风控', variant: 'destructive', dot: 'bg-red-500' },
  unknown: { text: '状态未知', variant: 'outline', dot: 'bg-zinc-400' },
  unconfigured: { text: '未配置 Cookie', variant: 'outline', dot: 'bg-zinc-400' },
};

export function CookieStatusBadge(): React.JSX.Element {
  const [info, setInfo] = useState<CookieStatusInfo>({ configured: false });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function tick(): Promise<void> {
      try {
        const res = await fetch('/api/cookie');
        const json = await res.json();
        if (cancelled) return;
        if (!json.configured) {
          setInfo({ configured: false });
        } else {
          setInfo({
            configured: true,
            status: json.status,
            accountUserId: json.accountUserId,
            cooldownUntil: json.cooldownUntil,
          });
        }
      } catch {
        if (!cancelled) setInfo({ configured: false });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    tick();
    const timer = setInterval(tick, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const key: Status = !info.configured ? 'unconfigured' : (info.status ?? 'unknown');
  const { text, variant, dot } = LABEL[key];

  return (
    <Link href="/cookie" className="no-underline">
      <Badge variant={variant} className="gap-2 font-normal">
        <span className={`h-2 w-2 rounded-full ${dot} ${loading ? 'animate-pulse' : ''}`} />
        {text}
      </Badge>
    </Link>
  );
}
