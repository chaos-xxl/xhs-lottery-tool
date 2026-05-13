/**
 * POST /api/rounds/:id/confirm — 手动确认中奖者入库
 *
 * 流程：校验 confirmed_ids ⊆ selected_ids → 事务写 win_history + 更新 round
 *
 * 对应 tasks.md Task 6.8；requirements.md R12.3 / R13.2 / R14.4-14.6 / R21.2。
 */

import { eq } from 'drizzle-orm';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { errorResponse } from '../../../../../lib/api/errors';
import { openDatabase, runMigrations } from '../../../../../lib/db';
import { drawRounds } from '../../../../../lib/db/schema';
import { commitWinners } from '../../../../../lib/dedup/win-history';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ConfirmSchema = z.object({
  confirmedIds: z.array(z.string()).min(1, '至少确认一个中奖者'),
});

type RouteContext = { params: { id: string } };

export async function POST(req: Request, ctx: RouteContext): Promise<NextResponse> {
  try {
    const roundId = ctx.params.id;
    const body = ConfirmSchema.parse(await req.json());

    const { db } = openDatabase();
    runMigrations(db);

    const [round] = db.select().from(drawRounds).where(eq(drawRounds.id, roundId)).limit(1).all();
    if (!round) {
      return NextResponse.json(
        { ok: false, code: 'round_not_found', message: '轮次不存在' },
        { status: 404 },
      );
    }

    if (round.status !== 'drawn') {
      return NextResponse.json(
        {
          ok: false,
          code: 'already_confirmed',
          message: `该轮次状态为 ${round.status}，无法再次确认`,
        },
        { status: 409 },
      );
    }

    // 校验 confirmedIds ⊆ selectedIds
    const selectedSet = new Set(round.selectedIds ?? []);
    const unauthorized = body.confirmedIds.filter((id) => !selectedSet.has(id));
    if (unauthorized.length > 0) {
      return NextResponse.json(
        {
          ok: false,
          code: 'unauthorized_user',
          message: `confirmedIds 包含不在 selectedIds 中的用户：${unauthorized.join(', ')}`,
        },
        { status: 400 },
      );
    }

    // 单事务：写 win_history + 更新 round
    const now = Date.now();
    db.transaction((tx) => {
      commitWinners(tx, {
        roundId,
        postId: round.postId,
        prizeName: round.prizeName,
        userIds: body.confirmedIds,
        now,
      });

      tx.update(drawRounds)
        .set({
          status: 'confirmed',
          confirmedIds: body.confirmedIds,
          confirmedAt: now,
        })
        .where(eq(drawRounds.id, roundId))
        .run();
    });

    return NextResponse.json({
      ok: true,
      confirmedIds: body.confirmedIds,
      nextTimeBlacklisted: body.confirmedIds.length,
      confirmedAt: now,
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
