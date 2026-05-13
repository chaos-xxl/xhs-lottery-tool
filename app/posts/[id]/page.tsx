'use client';

/**
 * 帖子详情页：配置条件 + 抓取 + 开奖
 */

import { useRouter } from 'next/navigation';
import { use, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../../components/ui/card';
import { Checkbox } from '../../../components/ui/checkbox';
import { Input } from '../../../components/ui/input';
import { Label } from '../../../components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../../../components/ui/select';
import { Switch } from '../../../components/ui/switch';

interface Post {
  id: string;
  title: string;
  authorId: string;
  createdAt: number;
  importedAt: number;
  lastFetchedAt: number | null;
}

const CONDITIONS: Array<{
  key: 'like' | 'collect' | 'follow' | 'comment';
  label: string;
  hint?: string;
}> = [
  { key: 'like', label: '点赞' },
  { key: 'collect', label: '收藏' },
  { key: 'follow', label: '关注', hint: '需手动确认' },
  { key: 'comment', label: '评论' },
];

export default function PostPage({
  params,
}: {
  params: Promise<{ id: string }>;
}): React.JSX.Element {
  const { id } = use(params);
  const router = useRouter();

  const [post, setPost] = useState<Post | null>(null);
  const [interactionCount, setInteractionCount] = useState(0);

  const [selectedConditions, setSelectedConditions] = useState<Set<string>>(new Set(['comment']));
  const [relation, setRelation] = useState<'AND' | 'OR'>('AND');
  const [winnerCount, setWinnerCount] = useState(3);
  const [prizeName, setPrizeName] = useState('');
  const [threshold, setThreshold] = useState(0.6);
  const [ignoreBlacklist, setIgnoreBlacklist] = useState(false);

  const [fetching, setFetching] = useState(false);
  const [drawing, setDrawing] = useState(false);

  useEffect(() => {
    fetch(`/api/posts/${id}/fetch`)
      .then((r) => r.json())
      .then((json) => {
        if (json.ok) {
          setPost(json.post);
          setInteractionCount(json.interactionCount);
        }
      });
  }, [id]);

  async function startFetch(): Promise<void> {
    if (selectedConditions.size === 0) {
      toast.error('请至少选择一种互动类型');
      return;
    }
    setFetching(true);
    try {
      const res = await fetch(`/api/posts/${id}/fetch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          conditions: Array.from(selectedConditions),
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        toast.error(json.message ?? '抓取失败', { description: json.hint });
        return;
      }
      toast.success(`抓取完成：${json.fetched} 人`, {
        description: json.partial ? `中途中断：${json.abortReason}` : undefined,
      });
      setInteractionCount(json.totalInDb);
    } catch (err) {
      toast.error('抓取失败', { description: String(err) });
    } finally {
      setFetching(false);
    }
  }

  async function startDraw(): Promise<void> {
    if (selectedConditions.size === 0) {
      toast.error('请至少选择一种互动类型');
      return;
    }
    setDrawing(true);
    try {
      const res = await fetch('/api/rounds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          postId: id,
          conditions: Array.from(selectedConditions),
          relation,
          winnerCount,
          prizeName,
          filters: { lowQualityCommentThreshold: threshold },
          ignoreBlacklist,
        }),
      });
      const json = await res.json();
      if (!json.ok) {
        toast.error(json.message ?? '开奖失败', { description: json.hint });
        return;
      }
      toast.success('已开奖');
      router.push(`/posts/${id}/rounds/${json.roundId}`);
    } catch (err) {
      toast.error('开奖失败', { description: String(err) });
    } finally {
      setDrawing(false);
    }
  }

  if (!post) {
    return <div className="text-sm text-muted-foreground">加载中…</div>;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <div className="text-xs text-muted-foreground">小红书帖子</div>
        <h1 className="mt-1 text-2xl font-semibold">{post.title || '（无标题）'}</h1>
        <div className="mt-2 text-xs text-muted-foreground">
          发布于 {new Date(post.createdAt).toLocaleString('zh-CN')} · 已抓到 {interactionCount}{' '}
          条互动
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">抽奖条件</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          <div>
            <Label className="mb-2 block">互动类型（多选）</Label>
            <div className="flex flex-wrap gap-3">
              {CONDITIONS.map((c) => {
                const checked = selectedConditions.has(c.key);
                const checkboxId = `condition-${c.key}`;
                return (
                  <label
                    key={c.key}
                    htmlFor={checkboxId}
                    className={`flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-sm ${
                      checked ? 'border-foreground' : 'border-border'
                    }`}
                  >
                    <Checkbox
                      id={checkboxId}
                      checked={checked}
                      onCheckedChange={(next) => {
                        setSelectedConditions((prev) => {
                          const s = new Set(prev);
                          if (next) s.add(c.key);
                          else s.delete(c.key);
                          return s;
                        });
                      }}
                    />
                    {c.label}
                    {c.hint && <span className="text-xs text-amber-600">({c.hint})</span>}
                  </label>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Label className="w-24">关系</Label>
            <Select value={relation} onValueChange={(v) => setRelation(v as 'AND' | 'OR')}>
              <SelectTrigger className="w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="AND">AND（都满足）</SelectItem>
                <SelectItem value="OR">OR（满足任一）</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-3">
            <Label htmlFor="winnerCount" className="w-24">
              抽多少人
            </Label>
            <Input
              id="winnerCount"
              type="number"
              min={1}
              max={1000}
              value={winnerCount}
              onChange={(e) => setWinnerCount(Number(e.target.value))}
              className="w-32"
            />
          </div>

          <div className="flex items-center gap-3">
            <Label htmlFor="prizeName" className="w-24">
              奖品
            </Label>
            <Input
              id="prizeName"
              value={prizeName}
              onChange={(e) => setPrizeName(e.target.value)}
              placeholder="仅用于展示，例如「宝可梦周边 1 份」"
              className="flex-1"
            />
          </div>

          <div className="flex items-center gap-3">
            <Label htmlFor="threshold" className="w-24">
              低质阈值
            </Label>
            <Input
              id="threshold"
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="w-32"
            />
            <div className="text-xs text-muted-foreground">
              越小越严格；默认 0.6。设为 1 表示不过滤。
            </div>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border p-3">
            <div>
              <div className="text-sm font-medium">忽略 30 天中奖黑名单</div>
              <div className="text-xs text-muted-foreground">
                默认关闭。开启后，近 30 天已中过奖的人也会参与抽奖。
              </div>
            </div>
            <Switch checked={ignoreBlacklist} onCheckedChange={setIgnoreBlacklist} />
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-3">
        <Button variant="outline" onClick={startFetch} disabled={fetching}>
          {fetching ? '抓取中…' : '抓取 / 刷新互动数据'}
        </Button>
        <Button onClick={startDraw} disabled={drawing || interactionCount === 0}>
          {drawing ? '开奖中…' : '开始开奖'}
        </Button>
      </div>
      {interactionCount === 0 && (
        <div className="text-xs text-muted-foreground">
          当前还没有抓到互动。先点「抓取 / 刷新互动数据」再开奖。
        </div>
      )}
    </div>
  );
}
