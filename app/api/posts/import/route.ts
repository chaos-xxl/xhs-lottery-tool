/**
 * POST /api/posts/import — 导入小红书帖子链接
 *
 * 流程：parse-url → ensureSelfPost → 落库 posts 表
 *
 * 对应 tasks.md Task 6.3；requirements.md R1 / R5.2 / R6。
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '../../../../lib/api/errors';
import { openSession } from '../../../../lib/api/session';
import { openDatabase, runMigrations } from '../../../../lib/db';
import { posts } from '../../../../lib/db/schema';
import { ensureSelfPost } from '../../../../lib/xhs/author-guard';
import { parseXhsUrl } from '../../../../lib/xhs/parse-url';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ImportSchema = z.object({
  url: z.string().min(1, 'url 不能为空'),
});

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const { url } = ImportSchema.parse(await req.json());

    const parsed = await parseXhsUrl(url);
    const session = openSession();
    const guard = await ensureSelfPost(session.client, {
      noteId: parsed.noteId,
      xsecToken: parsed.xsecToken,
      xsecSource: parsed.xsecSource,
      currentUserId: session.currentUserId ?? '',
    });

    if (!guard.ok) {
      if (guard.error) throw guard.error;
      return NextResponse.json(
        {
          ok: false,
          code: guard.reason,
          message: guard.message,
        },
        { status: guard.reason === 'not_self_post' ? 403 : 409 },
      );
    }

    const { db } = openDatabase();
    runMigrations(db);

    const now = Date.now();
    db.insert(posts)
      .values({
        id: parsed.noteId,
        xsecToken: parsed.xsecToken,
        xsecSource: parsed.xsecSource,
        title: guard.noteTitle,
        authorId: guard.authorId,
        authorName: '',
        createdAt: guard.publishedAt,
        importedAt: now,
        rawUrl: parsed.rawUrl,
      })
      .onConflictDoUpdate({
        target: posts.id,
        set: {
          xsecToken: parsed.xsecToken,
          title: guard.noteTitle,
          rawUrl: parsed.rawUrl,
        },
      })
      .run();

    return NextResponse.json({
      ok: true,
      post: {
        id: parsed.noteId,
        title: guard.noteTitle,
        authorId: guard.authorId,
        publishedAt: guard.publishedAt,
        importedAt: now,
        rawUrl: parsed.rawUrl,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { ok: false, code: 'invalid_input', message: err.issues[0]?.message ?? '参数错误' },
        { status: 400 },
      );
    }
    return errorResponse(err);
  }
}
