/**
 * POST /api/posts/:id/fetch — 抓取帖子互动用户
 *
 * 对应 tasks.md Task 6.5；R1.3 / R2.5 / R7.*。
 */

import { and, eq, sql } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '../../../../../lib/api/errors';
import { getRateLimiter, openSession } from '../../../../../lib/api/session';
import { openDatabase, runMigrations } from '../../../../../lib/db';
import { interactions, posts } from '../../../../../lib/db/schema';
import { ensureSelfPost } from '../../../../../lib/xhs/author-guard';
import { isExpiringSoon } from '../../../../../lib/xhs/cookie-monitor';
import { fetchInteractions, type InteractionKind } from '../../../../../lib/xhs/fetch-interactions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const InteractionKindSchema = z.enum(['like', 'collect', 'follow', 'comment']);

const FetchSchema = z.object({
  conditions: z.array(InteractionKindSchema).min(1, '至少选择一种互动类型'),
});

type RouteContext = { params: { id: string } };

export async function POST(req: Request, ctx: RouteContext): Promise<NextResponse> {
  try {
    const postId = ctx.params.id;
    const body = FetchSchema.parse(await req.json());

    const session = openSession();

    // Cookie 健康度：非 healthy 禁止抓取（R2.5）
    const status = await session.monitor.probe();
    if (status.status !== 'healthy' && status.status !== 'unknown') {
      return NextResponse.json(
        {
          ok: false,
          code: 'cookie_unhealthy',
          message: `Cookie 状态为 ${status.status}，暂不能抓取`,
          hint: '请先去 Cookie 配置页重新导入',
        },
        { status: 409 },
      );
    }

    // Cookie 即将过期检测
    if (status.expiresInMs !== null && isExpiringSoon(status.expiresInMs)) {
      return NextResponse.json(
        {
          ok: false,
          code: 'cookie_expiring',
          message: 'Cookie 即将过期（剩余不到24小时），请先去 /cookie 页面重新导入',
          expiresInMs: status.expiresInMs,
        },
        { status: 401 },
      );
    }

    const { db } = openDatabase();
    runMigrations(db);

    const [post] = db.select().from(posts).where(eq(posts.id, postId)).limit(1).all();
    if (!post) {
      return NextResponse.json(
        { ok: false, code: 'post_not_found', message: '帖子未导入' },
        { status: 404 },
      );
    }

    // 再查一次自帖校验（双保险）
    const guard = await ensureSelfPost(session.client, {
      noteId: post.id,
      xsecToken: post.xsecToken,
      xsecSource: post.xsecSource,
      currentUserId: session.currentUserId ?? '',
    });
    if (!guard.ok) {
      if (guard.error) throw guard.error;
      return NextResponse.json(
        { ok: false, code: guard.reason, message: guard.message },
        { status: guard.reason === 'not_self_post' ? 403 : 409 },
      );
    }

    // 执行抓取
    const result = await fetchInteractions(
      session.client,
      getRateLimiter(),
      {
        noteId: post.id,
        xsecToken: post.xsecToken,
        xsecSource: post.xsecSource,
      },
      body.conditions as readonly InteractionKind[],
    );

    // UPSERT 每个 user（以最新为准 R7.6）
    const now = Date.now();
    db.transaction((tx) => {
      for (const rec of result.users.values()) {
        tx.insert(interactions)
          .values({
            postId: post.id,
            userId: rec.userId,
            userNickname: rec.userNickname,
            userAvatar: rec.userAvatar,
            followedBlogger: rec.followedBlogger,
            types: rec.types,
            ...(rec.commentText !== undefined ? { commentText: rec.commentText } : {}),
            ...(rec.commentCreatedAt !== undefined
              ? { commentCreatedAt: rec.commentCreatedAt }
              : {}),
            ...(rec.userFollowsCount !== undefined
              ? { userFollowsCount: rec.userFollowsCount }
              : {}),
            ...(rec.userFansCount !== undefined ? { userFansCount: rec.userFansCount } : {}),
            fetchedAt: now,
          })
          .onConflictDoUpdate({
            target: [interactions.postId, interactions.userId],
            set: {
              userNickname: rec.userNickname,
              userAvatar: rec.userAvatar,
              followedBlogger: rec.followedBlogger,
              types: rec.types,
              commentText: rec.commentText ?? null,
              commentCreatedAt: rec.commentCreatedAt ?? null,
              userFollowsCount: rec.userFollowsCount ?? null,
              userFansCount: rec.userFansCount ?? null,
              fetchedAt: now,
            },
          })
          .run();
      }

      tx.update(posts).set({ lastFetchedAt: now }).where(eq(posts.id, post.id)).run();
    });

    // 查一下本帖总计多少条 interaction（UI 展示）
    const totalRow = db
      .select({ total: sql<number>`count(*)` })
      .from(interactions)
      .where(eq(interactions.postId, post.id))
      .all()[0];

    return NextResponse.json({
      ok: true,
      fetched: result.users.size,
      totalInDb: totalRow?.total ?? 0,
      abortReason: result.abortReason ?? null,
      partial: result.partial ?? false,
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

/**
 * GET /api/posts/:id/fetch — 查询本帖已抓到的 interactions 数量 + 最新抓取时间
 */
export async function GET(_req: Request, ctx: RouteContext): Promise<NextResponse> {
  try {
    const { db } = openDatabase();
    runMigrations(db);

    const [post] = db.select().from(posts).where(eq(posts.id, ctx.params.id)).limit(1).all();

    if (!post) {
      return NextResponse.json(
        { ok: false, code: 'post_not_found', message: '帖子未导入' },
        { status: 404 },
      );
    }

    const totalRow = db
      .select({ total: sql<number>`count(*)` })
      .from(interactions)
      .where(eq(interactions.postId, post.id))
      .all()[0];

    return NextResponse.json({
      ok: true,
      post,
      interactionCount: totalRow?.total ?? 0,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
