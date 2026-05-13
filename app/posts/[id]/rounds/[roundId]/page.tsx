'use client';

/**
 * 开奖结果 + 手动确认页
 *
 * 对应 requirements.md R14 / R11.2。
 */

import { use, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Badge } from '../../../../../components/ui/badge';
import { Button } from '../../../../../components/ui/button';
import { Card, CardContent } from '../../../../../components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../../../../components/ui/dialog';
import { Input } from '../../../../../components/ui/input';

interface Candidate {
  userId: string;
  userNickname: string;
  userAvatar: string;
  followedBlogger: boolean;
  types: string[];
  commentText: string | null;
  userFollowsCount?: number;
  userFansCount?: number;
}

interface RoundData {
  round: {
    id: string;
    prizeName: string;
    winnerCount: number;
    commitHash: string;
    seed: string;
    status: 'drafted' | 'drawn' | 'confirmed';
    selectedIds: string[];
    confirmedIds: string[];
    drawnAt: number;
    confirmedAt: number | null;
  };
  selectedCandidates: Candidate[];
}

export default function RoundPage({
  params,
}: {
  params: Promise<{ id: string; roundId: string }>;
}): React.JSX.Element {
  const { id, roundId } = use(params);

  const [data, setData] = useState<RoundData | null>(null);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [digitInput, setDigitInput] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/rounds/${roundId}`)
      .then((r) => r.json())
      .then((json) => {
        if (json.ok) {
          setData(json);
          setCheckedIds(new Set(json.round.selectedIds));
        }
      });
  }, [roundId]);

  const expectedDigit = checkedIds.size;

  async function copyCommit(): Promise<void> {
    if (!data) return;
    await navigator.clipboard.writeText(data.round.commitHash);
    toast.success('已复制 Commit Hash');
  }

  async function redraw(excluded: string): Promise<void> {
    try {
      const res = await fetch(`/api/rounds/${roundId}/redraw`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ excludeIds: [excluded] }),
      });
      const json = await res.json();
      if (!json.ok) {
        toast.error(json.message ?? '补抽失败');
        return;
      }
      toast.success(`补抽：${json.winnerDetail?.userNickname ?? json.newWinner}`);
      const refreshed = await (await fetch(`/api/rounds/${roundId}`)).json();
      if (refreshed.ok) {
        setData(refreshed);
        setCheckedIds(new Set(refreshed.round.selectedIds));
      }
    } catch (err) {
      toast.error('补抽失败', { description: String(err) });
    }
  }

  async function confirm(): Promise<void> {
    if (!data) return;
    setSubmitting(true);
    try {
      const res = await fetch(`/api/rounds/${roundId}/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmedIds: Array.from(checkedIds) }),
      });
      const json = await res.json();
      if (!json.ok) {
        toast.error(json.message ?? '确认失败');
        return;
      }
      toast.success(`已入库 ${json.nextTimeBlacklisted} 人，下次抽奖自动排除`);
      setConfirmOpen(false);
      const refreshed = await (await fetch(`/api/rounds/${roundId}`)).json();
      if (refreshed.ok) setData(refreshed);
    } finally {
      setSubmitting(false);
    }
  }

  if (!data) {
    return <div className="text-sm text-muted-foreground">加载中…</div>;
  }

  const { round, selectedCandidates } = data;
  const isConfirmed = round.status === 'confirmed';

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <div className="text-xs text-muted-foreground">第 #{round.id.slice(0, 8)} 轮</div>
        <h1 className="mt-1 text-2xl font-semibold">
          {round.prizeName || `抽 ${round.winnerCount} 人`}
        </h1>
        <div className="mt-2 text-xs text-muted-foreground">
          开奖于 {new Date(round.drawnAt).toLocaleString('zh-CN')}
          {isConfirmed && round.confirmedAt
            ? ` · 确认于 ${new Date(round.confirmedAt).toLocaleString('zh-CN')}`
            : ''}
        </div>
      </div>

      <Card>
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs text-muted-foreground">Commit Hash（可公示给粉丝）</div>
              <code className="mt-1 block text-xs">{round.commitHash}</code>
            </div>
            <Button variant="outline" size="sm" onClick={copyCommit}>
              复制
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">
          中奖候选（{selectedCandidates.length} 人）
        </h2>
        {selectedCandidates.map((c) => {
          const checked = checkedIds.has(c.userId);
          return (
            <Card key={c.userId} className={checked ? '' : 'border-dashed opacity-60'}>
              <CardContent className="flex items-center gap-4 p-4">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isConfirmed}
                  onChange={(e) => {
                    setCheckedIds((prev) => {
                      const s = new Set(prev);
                      if (e.target.checked) s.add(c.userId);
                      else s.delete(c.userId);
                      return s;
                    });
                  }}
                  className="h-5 w-5"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{c.userNickname || c.userId}</span>
                    {c.followedBlogger && (
                      <Badge variant="secondary" className="h-5 text-xs">
                        已关注
                      </Badge>
                    )}
                    {c.types?.map((t) => (
                      <Badge key={t} variant="outline" className="h-5 text-xs font-normal">
                        {typeLabel(t)}
                      </Badge>
                    ))}
                    <a
                      href={`https://www.xiaohongshu.com/user/profile/${c.userId}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-500 hover:underline"
                    >
                      查看主页 ↗
                    </a>
                  </div>
                  {c.commentText && (
                    <div className="mt-1 text-sm text-muted-foreground">「{c.commentText}」</div>
                  )}
                  {!c.followedBlogger && (
                    <div className="mt-1 text-xs text-amber-600">
                      ⚠️ 关注状态未验证 — 请点"查看主页"确认是否已关注你
                    </div>
                  )}
                </div>
                {!isConfirmed && !checked && (
                  <Button variant="ghost" size="sm" onClick={() => redraw(c.userId)}>
                    补抽一名
                  </Button>
                )}
                {!isConfirmed && checked && !c.followedBlogger && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-amber-600 border-amber-300"
                    onClick={() => {
                      setCheckedIds((prev) => {
                        const s = new Set(prev);
                        s.delete(c.userId);
                        return s;
                      });
                      redraw(c.userId);
                    }}
                  >
                    未关注，换人
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      {!isConfirmed && (
        <div className="flex items-center justify-between border-t border-border pt-4">
          <div className="text-sm text-muted-foreground">
            将入库 {checkedIds.size} 人到 30 天中奖黑名单
          </div>
          <Button
            disabled={checkedIds.size === 0}
            onClick={() => {
              setDigitInput('');
              setConfirmOpen(true);
            }}
          >
            确认入库
          </Button>
        </div>
      )}

      {isConfirmed && (
        <div className="rounded-md border border-emerald-500/40 bg-emerald-500/5 p-4 text-sm">
          ✅ 已入库 {round.confirmedIds.length} 人，下次抽奖自动排除。
        </div>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>确认把 {checkedIds.size} 人入库？</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            <div>入库后将记录到 30 天中奖黑名单，下次抽奖自动排除。</div>
            <div className="text-muted-foreground">
              为防止误点，请输入数字 <strong>{expectedDigit}</strong> 以确认。
            </div>
            <Input
              autoFocus
              value={digitInput}
              onChange={(e) => setDigitInput(e.target.value)}
              placeholder={String(expectedDigit)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button disabled={digitInput !== String(expectedDigit) || submitting} onClick={confirm}>
              {submitting ? '入库中…' : '确认入库'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function typeLabel(t: string): string {
  return { like: '点赞', collect: '收藏', follow: '关注', comment: '评论' }[t] ?? t;
}
