/**
 * DELETE /api/self-destruct — 一键清除 Cookie / master key / SQLite / 日志
 *
 * 对应 tasks.md Task 6.12；requirements.md R4.4 / R18。
 *
 * 安全约束：
 *   - 必须带 header `x-confirm: 清除`
 *   - 严格 3 秒内完成（R18.3）
 */

import { NextResponse } from 'next/server';
import { errorResponse } from '../../../lib/api/errors';
import { resetSessionCache } from '../../../lib/api/session';
import { SecureStore } from '../../../lib/config/secure-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function DELETE(req: Request): Promise<NextResponse> {
  try {
    const confirm = req.headers.get('x-confirm');
    if (confirm !== '清除') {
      return NextResponse.json(
        {
          ok: false,
          code: 'confirm_required',
          message: '自毁需要请求头 x-confirm: 清除',
        },
        { status: 400 },
      );
    }

    const deadline = Date.now() + 3000;
    const store = new SecureStore();
    store.clearAll();
    resetSessionCache();

    const elapsed = Date.now() - deadline + 3000;

    return NextResponse.json({
      ok: true,
      elapsedMs: elapsed,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
