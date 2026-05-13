'use client';

/**
 * 历史记录页
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Card, CardContent } from '../../components/ui/card';

interface Round {
  id: string;
  postId: string;
  prizeName: string;
  winnerCount: number;
  commitHash: string;
  status: 'drafted' | 'drawn' | 'confirmed';
  drawnAt: number;
  confirmedAt: number | null;
  confirmedIds: string[];
}

export default function HistoryPage(): React.JSX.Element {
  const [rounds, setRounds] = useState<Round[]>([]);

  useEffect(() => {
    fetch('/api/rounds')
      .then((r) => r.json())
      .then((json) => setRounds(json.rounds ?? []))
      .catch(() => {});
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">历史记录</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          每一次开奖都可以回溯 commit hash 和 seed 来复算结果。
        </p>
      </div>

      {rounds.length === 0 ? (
        <Card>
          <CardContent className="p-10 text-center text-sm text-muted-foreground">
            还没有任何抽奖轮次。
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {rounds.map((r) => (
            <Link key={r.id} href={`/posts/${r.postId}/rounds/${r.id}`}>
              <Card className="transition hover:border-foreground/20">
                <CardContent className="flex items-center justify-between p-4">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{r.prizeName || `抽 ${r.winnerCount} 人`}</span>
                      <Badge
                        variant={r.status === 'confirmed' ? 'default' : 'secondary'}
                        className="h-5 text-xs font-normal"
                      >
                        {r.status === 'confirmed'
                          ? '已确认'
                          : r.status === 'drawn'
                            ? '待确认'
                            : '草稿'}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      <span>
                        {r.status === 'confirmed' && r.confirmedAt
                          ? `确认于 ${new Date(r.confirmedAt).toLocaleString('zh-CN')}`
                          : `开奖于 ${new Date(r.drawnAt).toLocaleString('zh-CN')}`}
                      </span>
                      <span>{r.confirmedIds?.length ?? 0} 人入库</span>
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {r.commitHash.slice(0, 12)}…
                    </div>
                  </div>
                  <div className="text-xs text-muted-foreground">→</div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
