'use client';

/**
 * 首页：粘贴链接 + 帖子列表
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Input } from '../components/ui/input';

interface PostRow {
  id: string;
  title: string;
  authorId: string;
  createdAt: number;
  importedAt: number;
  lastFetchedAt: number | null;
}

export default function HomePage(): React.JSX.Element {
  const router = useRouter();
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [posts, setPosts] = useState<PostRow[]>([]);

  useEffect(() => {
    fetch('/api/posts')
      .then((r) => r.json())
      .then((json) => setPosts(json.posts ?? []))
      .catch(() => {});
  }, []);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await fetch('/api/posts/import', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const json = await res.json();
      if (!json.ok) {
        toast.error(json.message ?? '导入失败', { description: json.hint });
        return;
      }
      toast.success('已导入', { description: json.post.title });
      router.push(`/posts/${json.post.id}`);
    } catch (err) {
      toast.error('导入失败', { description: String(err) });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-10">
      <section>
        <h1 className="text-3xl font-semibold tracking-tight">粉丝在等结果</h1>
        <p className="mt-3 text-muted-foreground">粘一条小红书链接，把这次抽奖好好做完。</p>
        <form onSubmit={submit} className="mt-6 flex gap-3">
          <Input
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://www.xiaohongshu.com/explore/..."
            className="flex-1"
            required
          />
          <Button type="submit" disabled={submitting || !url.trim()}>
            {submitting ? '导入中...' : '导入'}
          </Button>
        </form>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">已导入的帖子</h2>
        {posts.length === 0 ? (
          <Card>
            <CardContent className="p-10 text-center text-sm text-muted-foreground">
              还没有帖子。粘一条链接开始。
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3">
            {posts.map((p) => (
              <Link key={p.id} href={`/posts/${p.id}`}>
                <Card className="transition hover:border-foreground/20">
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{p.title || '（无标题）'}</div>
                      <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground">
                        <span>导入于 {new Date(p.importedAt).toLocaleString('zh-CN')}</span>
                        {p.lastFetchedAt ? (
                          <span>最近抓取：{new Date(p.lastFetchedAt).toLocaleString('zh-CN')}</span>
                        ) : (
                          <span className="italic">尚未抓取互动</span>
                        )}
                      </div>
                    </div>
                    <div className="text-xs text-muted-foreground">→</div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
