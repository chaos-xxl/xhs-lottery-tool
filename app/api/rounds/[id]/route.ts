/**
 * GET /api/rounds/:id — 单轮次详情（含候选列表 + 规则快照）
 */

import { eq, inArray } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { errorResponse } from '../../../../lib/api/errors';
import { openDatabase, runMigrations } from '../../../../lib/db';
import { drawRounds, interactions } from '../../../../lib/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: { id: string } };

export async function GET(_req: Request, ctx: RouteContext): Promise<NextResponse> {
  try {
    const { db } = openDatabase();
    runMigrations(db);

    const [round] = db
      .select()
      .from(drawRounds)
      .where(eq(drawRounds.id, ctx.params.id))
      .limit(1)
      .all();
    if (!round) {
      return NextResponse.json(
        { ok: false, code: 'round_not_found', message: '轮次不存在' },
        { status: 404 },
      );
    }

    const ids = round.selectedIds ?? [];
    const records =
      ids.length > 0
        ? db
            .select()
            .from(interactions)
            .where(inArray(interactions.userId, [...ids]))
            .all()
            .filter((r) => r.postId === round.postId)
        : [];

    return NextResponse.json({
      ok: true,
      round: {
        id: round.id,
        postId: round.postId,
        prizeName: round.prizeName,
        winnerCount: round.winnerCount,
        rules: round.rules,
        commitHash: round.commitHash,
        seed: round.seed,
        status: round.status,
        candidateCount: round.candidateIds?.length ?? 0,
        selectedIds: round.selectedIds,
        confirmedIds: round.confirmedIds,
        drawnAt: round.drawnAt,
        confirmedAt: round.confirmedAt,
        redrawAudit: round.redrawAudit,
      },
      selectedCandidates: records.map((r) => ({
        userId: r.userId,
        userNickname: r.userNickname,
        userAvatar: r.userAvatar,
        followedBlogger: r.followedBlogger,
        types: r.types,
        commentText: r.commentText,
        userFollowsCount: r.userFollowsCount,
        userFansCount: r.userFansCount,
      })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
