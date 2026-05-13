'use client';

/**
 * 自毁按钮：输入「清除」二字才能确认
 *
 * 对应 requirements.md R18。
 */

import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from './ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from './ui/dialog';
import { Input } from './ui/input';
import { Label } from './ui/label';

const CONFIRM_WORD = '清除';

export function SelfDestructButton(): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const canSubmit = confirm === CONFIRM_WORD && !submitting;

  async function handleSubmit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const res = await fetch('/api/self-destruct', {
        method: 'DELETE',
        headers: { 'x-confirm': CONFIRM_WORD },
      });
      const json = await res.json();
      if (!json.ok) {
        toast.error('清除失败', { description: json.message });
      } else {
        toast.success('已全部清除，即将刷新...');
        setTimeout(() => window.location.replace('/cookie'), 800);
      }
    } catch (err) {
      toast.error('清除失败', { description: String(err) });
    } finally {
      setSubmitting(false);
      setOpen(false);
      setConfirm('');
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="destructive" size="sm" className="font-normal">
          清除本地数据
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>确认清除所有本地数据？</DialogTitle>
          <DialogDescription>
            会删除 Cookie、主密钥、SQLite 数据库和本地日志。此操作不可撤销。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="self-destruct-confirm">输入「{CONFIRM_WORD}」二字以确认</Label>
          <Input
            id="self-destruct-confirm"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={CONFIRM_WORD}
            autoComplete="off"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            取消
          </Button>
          <Button variant="destructive" disabled={!canSubmit} onClick={handleSubmit}>
            {submitting ? '清除中...' : '确认清除'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
