/**
 * POST /api/rounds/:id/redraw — 补抽
 *
 * 流程：校验 excludeIds ⊆ selectedIds → derive(seed, excluded) → 更新 round
 *
 * 对应 tasks.md Task 6.10；requirements.md R14.3。
 */

import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '../../../../../lib/api/errors';
import { openSession } from '../../../../../lib/api/session';
import { openDatabase, runMigrations } from '../../../../../lib/db';
import { drawRounds, interactions } from '../../../../../lib/db/schema';
import { derive } from '../../../../../lib/lottery/draw';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const RedrawSchema = z.object({
  excludeIds: z.array(z.string()).min(1, '至少排除一个用户'),
});

type RouteContext = { params: { id: string } };

function getUserSecret(accountUserId: string | null): string {
  const base = accountUserId ?? 'anonymous-local-user';
  return `xhs-lottery-local-${base}`;
}

export async function POST(req: Request, ctx: RouteContext): Promise<NextResponse> {
  try {
    const roundId = ctx.params.id;
    const body = RedrawSchema.parse(await req.json());

    const { db } = openDatabase();
    runMigrations(db);

    const [round] = db.select().from(drawRounds).where(eq(drawRounds.id, roundId)).limit(1).all();
    if (!round) {
      return NextResponse.json(
        { ok: false, code: 'round_not_found', message: '轮次不存在' },
        { status: 404 },
      );
    }

    if (round.status === 'confirmed') {
      return NextResponse.json(
        {
          ok: false,
          code: 'already_confirmed',
          message: '该轮次已确认入库，不能再补抽',
        },
        { status: 409 },
      );
    }

    const selectedSet = new Set(round.selectedIds ?? []);
    const unauthorized = body.excludeIds.filter((id) => !selectedSet.has(id));
    if (unauthorized.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          code: 'exclude_not_in_selected',
          message: `excludeIds 包含不在 selectedIds 中的用户：${unauthorized.join(', ')}`,
        },
        { status: 400 },
      );
    }

    const session = openSession();
    const userSecret = getUserSecret(session.currentUserId);

    const result = derive({
      poolIds: round.candidateIds,
      originalSeed: round.seed,
      excludedIds: body.excludeIds,
      userSecret,
      winnerCount: 1,
    });

    const newWinner = result.winners[0];
    if (!newWinner) {
      return NextResponse.json(
        { ok: false, code: 'pool_insufficient', message: '候选池已空，无法补抽' },
        { status: 422 },
      );
    }

    // 更新 round.selectedIds + 审计
    const oldSelected = round.selectedIds ?? [];
    const newSelected = oldSelected.filter((id) => !body.excludeIds.includes(id)).concat(newWinner);

    const newAudit = [
      ...(round.redrawAudit ?? []),
      {
        excluded: body.excludeIds,
        newWinner,
        at: Date.now(),
      },
    ];

    db.update(drawRounds)
      .set({
        selectedIds: newSelected,
        redrawAudit: newAudit,
      })
      .where(eq(drawRounds.id, roundId))
      .run();

    // 返回补抽用户的详情
    const [winnerRecord] = db
      .select()
      .from(interactions)
      .where(eq(interactions.userId, newWinner))
      .limit(1)
      .all();

    return NextResponse.json({
      ok: true,
      newWinner,
      derivedSeed: result.seed,
      newSelected,
      winnerDetail: winnerRecord
        ? {
            userId: winnerRecord.userId,
            userNickname: winnerRecord.userNickname,
            userAvatar: winnerRecord.userAvatar,
            followedBlogger: winnerRecord.followedBlogger,
            commentText: winnerRecord.commentText,
          }
        : null,
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
