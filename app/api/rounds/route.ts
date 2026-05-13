/**
 * POST /api/rounds — 执行一次开奖
 *
 * 流程：cookie probe → 取互动 → blacklist → filter → quality → draw → 落 draw_rounds
 *
 * 对应 tasks.md Task 6.6；requirements.md R2.2 / R9-R13。
 */

import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '../../../lib/api/errors';
import { openSession } from '../../../lib/api/session';
import { openDatabase, runMigrations } from '../../../lib/db';
import {
  drawRounds,
  type InteractionType,
  interactions,
  type LotteryRules,
  posts,
} from '../../../lib/db/schema';
import { getRecentWinners } from '../../../lib/dedup/win-history';
import { draw } from '../../../lib/lottery/draw';
import { filterCandidates, type LotteryRelation } from '../../../lib/lottery/filter';
import { passesQualityFilter } from '../../../lib/lottery/quality';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const InteractionKindSchema = z.enum(['like', 'collect', 'follow', 'comment']);

const RoundSchema = z.object({
  postId: z.string().min(1),
  conditions: z.array(InteractionKindSchema).min(1),
  relation: z.enum(['AND', 'OR']),
  winnerCount: z.number().int().positive().max(1000),
  prizeName: z.string().max(200).default(''),
  filters: z
    .object({
      lowQualityCommentThreshold: z.number().min(0).max(1).optional(),
    })
    .optional(),
  ignoreBlacklist: z.boolean().default(false),
});

/**
 * 本地 HMAC 用户密钥（首次读取 secure-store 时自动生成 / 存储在 metadata 里也可以）
 * 这里简化：使用 SecureStore 的 accountUserId + 固定盐派生，保证同机稳定。
 */
function getUserSecret(accountUserId: string | null): string {
  const base = accountUserId ?? 'anonymous-local-user';
  return `xhs-lottery-local-${base}`;
}

export async function POST(req: Request): Promise<NextResponse> {
  try {
    const input = RoundSchema.parse(await req.json());
    const session = openSession();

    const status = await session.monitor.probe();
    if (status.status === 'challenge_required' || status.status === 'expired') {
      return NextResponse.json(
        {
          ok: false,
          code: 'cookie_unhealthy',
          message: `Cookie 状态为 ${status.status}，暂不能开奖`,
        },
        { status: 409 },
      );
    }

    const { db } = openDatabase();
    runMigrations(db);

    const [post] = db.select().from(posts).where(eq(posts.id, input.postId)).limit(1).all();
    if (!post) {
      return NextResponse.json(
        { ok: false, code: 'post_not_found', message: '帖子未导入' },
        { status: 404 },
      );
    }

    // 载入本帖所有互动
    const rawList = db
      .select()
      .from(interactions)
      .where(eq(interactions.postId, input.postId))
      .all();

    if (rawList.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          code: 'no_interactions',
          message: '当前帖子还没有抓取到任何互动，请先抓取',
        },
        { status: 422 },
      );
    }

    // 归一化给 filter 用
    const forFilter = rawList.map((row) => ({
      userId: row.userId,
      types: (row.types ?? []) as readonly InteractionType[],
      followedBlogger: row.followedBlogger,
    }));

    // 黑名单（30 天去重，可被 ignoreBlacklist 关闭）
    const blacklist = input.ignoreBlacklist ? new Set<string>() : getRecentWinners(db);

    // 条件过滤（AND/OR）
    const conditionFiltered = filterCandidates(
      forFilter,
      { conditions: input.conditions, relation: input.relation as LotteryRelation },
      blacklist,
    );

    // 低质评分过滤
    const qualityById = new Map(rawList.map((r) => [r.userId, r]));
    const qualityThreshold = input.filters?.lowQualityCommentThreshold;
    const finalPool: string[] = [];
    for (const u of conditionFiltered) {
      const rec = qualityById.get(u.userId);
      if (!rec) continue;
      const passed = passesQualityFilter(
        {
          userId: rec.userId,
          ...(rec.userFollowsCount !== null && rec.userFollowsCount !== undefined
            ? { userFollowsCount: rec.userFollowsCount }
            : {}),
          ...(rec.userFansCount !== null && rec.userFansCount !== undefined
            ? { userFansCount: rec.userFansCount }
            : {}),
          ...(rec.commentText ? { commentText: rec.commentText } : {}),
        },
        qualityThreshold !== undefined ? { lowQualityCommentThreshold: qualityThreshold } : {},
      );
      if (passed) finalPool.push(rec.userId);
    }

    // 抽奖（commit-reveal）
    const userSecret = getUserSecret(session.currentUserId);
    const result = draw({
      poolIds: finalPool,
      winnerCount: input.winnerCount,
      userSecret,
    });

    // 落库 draw_rounds
    const roundId = randomUUID();
    const now = Date.now();
    const rulesSnapshot: LotteryRules = {
      conditions: input.conditions as readonly InteractionType[],
      relation: input.relation,
      filters:
        qualityThreshold !== undefined ? { lowQualityCommentThreshold: qualityThreshold } : {},
      blacklistAtDraw: Array.from(blacklist),
      ignoreBlacklist: input.ignoreBlacklist,
    };

    db.insert(drawRounds)
      .values({
        id: roundId,
        postId: input.postId,
        prizeName: input.prizeName,
        winnerCount: input.winnerCount,
        rules: rulesSnapshot,
        seed: result.seed,
        commitHash: result.commitHash,
        candidateIds: finalPool,
        selectedIds: result.winners,
        status: 'drawn',
        drawnAt: now,
      })
      .run();

    // 返回候选详细信息（用户卡片用）
    const selectedRecords = rawList.filter((r) => result.winners.includes(r.userId));

    return NextResponse.json({
      ok: true,
      roundId,
      commitHash: result.commitHash,
      winners: result.winners,
      candidateCount: finalPool.length,
      selectedCandidates: selectedRecords.map((r) => ({
        userId: r.userId,
        userNickname: r.userNickname,
        userAvatar: r.userAvatar,
        followedBlogger: r.followedBlogger,
        types: r.types,
        commentText: r.commentText,
      })),
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
 * GET /api/rounds?postId=... — 列出某帖的所有轮次（历史记录）
 */
export async function GET(req: Request): Promise<NextResponse> {
  try {
    const { searchParams } = new URL(req.url);
    const postIdFilter = searchParams.get('postId');

    const { db } = openDatabase();
    runMigrations(db);

    const rows = postIdFilter
      ? db.select().from(drawRounds).where(eq(drawRounds.postId, postIdFilter)).all()
      : db.select().from(drawRounds).all();

    // 按时间倒序
    rows.sort((a, b) => (b.drawnAt ?? 0) - (a.drawnAt ?? 0));

    return NextResponse.json({
      ok: true,
      rounds: rows.map((r) => ({
        id: r.id,
        postId: r.postId,
        prizeName: r.prizeName,
        winnerCount: r.winnerCount,
        commitHash: r.commitHash,
        status: r.status,
        drawnAt: r.drawnAt,
        confirmedAt: r.confirmedAt,
        confirmedIds: r.confirmedIds,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
