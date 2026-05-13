'use client';

/**
 * Cookie 配置页
 *
 * 对应 requirements.md R8（Cookie 导入 + 校验）。
 */

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '../../components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';

interface CookieMeta {
  configured: boolean;
  status?: string;
  accountUserId?: string | null;
  createdAt?: number | null;
  lastValidatedAt?: number | null;
}

export default function CookiePage(): React.JSX.Element {
  const [meta, setMeta] = useState<CookieMeta | null>(null);
  const [cookieStr, setCookieStr] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/cookie')
      .then((r) => r.json())
      .then(setMeta)
      .catch(() => setMeta({ configured: false }));
  }, []);

  async function submit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setSubmitting(true);
    setLastError(null);
    try {
      const res = await fetch('/api/cookie', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cookieString: cookieStr }),
      });
      const json = await res.json();
      if (!json.ok) {
        setLastError(json.message ?? 'Cookie 校验失败');
        toast.error('Cookie 校验失败', { description: json.message });
      } else {
        toast.success('Cookie 已保存', {
          description: `状态：${json.status}${json.accountUserId ? `  账号：${json.accountUserId}` : ''}`,
        });
        setMeta({
          configured: true,
          status: json.status,
          accountUserId: json.accountUserId,
        });
        setCookieStr('');
      }
    } catch (err) {
      setLastError(String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">配置小红书 Cookie</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          你的 Cookie 只保存在本机，经 AES-256-GCM
          加密。任何时候都能用右上角「清除本地数据」一键抹去。
        </p>
      </div>

      {meta?.configured && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">当前已配置</CardTitle>
            <CardDescription>
              账号 ID：{meta.accountUserId ?? '—'} · 状态：{meta.status ?? '—'}
            </CardDescription>
          </CardHeader>
          {meta.createdAt && (
            <CardContent className="text-xs text-muted-foreground">
              导入时间：{new Date(meta.createdAt).toLocaleString('zh-CN')}
              {meta.lastValidatedAt
                ? `  ·  最近校验：${new Date(meta.lastValidatedAt).toLocaleString('zh-CN')}`
                : ''}
            </CardContent>
          )}
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">怎么拿到 Cookie</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm leading-6 text-muted-foreground">
          <p>1. 用 Chrome 登录 xiaohongshu.com</p>
          <p>
            2. 打开 DevTools → Application → Cookies →{' '}
            <code className="mx-1 rounded bg-muted px-1">www.xiaohongshu.com</code>
          </p>
          <p>3. 找到下面三个字段，把值分别粘进下面三个输入框</p>
          <ul className="ml-6 list-disc">
            <li>
              <code>web_session</code>
            </li>
            <li>
              <code>a1</code>
            </li>
            <li>
              <code>webId</code>
            </li>
          </ul>
        </CardContent>
      </Card>

      <form onSubmit={submit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="cookieString">Cookie 字符串（整段粘贴）</Label>
          <textarea
            id="cookieString"
            value={cookieStr}
            onChange={(e) => setCookieStr(e.target.value)}
            placeholder="从浏览器 DevTools → Application → Cookies 复制整段，例如：a1=xxx; web_session=xxx; webId=xxx; ..."
            className="flex min-h-[120px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            autoComplete="off"
            required
          />
          <p className="text-xs text-muted-foreground">
            不用手动拆字段——直接把整段 Cookie 粘进来就行。系统会自动提取 web_session / a1 / webId。
          </p>
        </div>
        {lastError && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {lastError}
          </div>
        )}
        <Button type="submit" disabled={submitting}>
          {submitting ? '校验中...' : '保存并立即校验'}
        </Button>
      </form>
    </div>
  );
}
