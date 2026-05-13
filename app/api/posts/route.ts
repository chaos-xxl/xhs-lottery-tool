/**
 * GET /api/posts — 已导入的帖子列表（按导入时间倒序）
 */

import { desc } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { errorResponse } from '../../../lib/api/errors';
import { openDatabase, runMigrations } from '../../../lib/db';
import { posts } from '../../../lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<NextResponse> {
  try {
    const { db } = openDatabase();
    runMigrations(db);

    const list = db
      .select({
        id: posts.id,
        title: posts.title,
        authorId: posts.authorId,
        createdAt: posts.createdAt,
        importedAt: posts.importedAt,
        lastFetchedAt: posts.lastFetchedAt,
      })
      .from(posts)
      .orderBy(desc(posts.importedAt))
      .all();

    return NextResponse.json({ ok: true, posts: list });
  } catch (err) {
    return errorResponse(err);
  }
}
