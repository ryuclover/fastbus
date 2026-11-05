import { NextRequest } from "next/server";
import { z } from "zod";
import { db, transaction } from "@/lib/server/database";
import { seal } from "@/lib/server/crypto";
import { monitorSchema } from "@/lib/monitoring/schema";
import {
  body,
  endpoint,
  HttpError,
  json,
  originCheck,
  requireUser,
} from "@/lib/server/http";
export const runtime = "nodejs";
type Context = {
  params: Promise<{
    id: string;
  }>;
};
export async function PUT(request: NextRequest, context: Context) {
  return endpoint(async () => {
    originCheck(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    const config = await body(request, monitorSchema);
    await transaction(async () => {
      const result = await db()
        .prepare(
          "UPDATE monitors SET config=?,cursor=0,status='Critérios atualizados' WHERE id=? AND user_id=?",
        )
        .run(seal(config, id), id, user.id);
      if (!result.changes)
        throw new HttpError(404, "Monitoramento não encontrado.");
      await db().prepare("DELETE FROM observations WHERE monitor_id=?").run(id);
      await db()
        .prepare(
          "UPDATE alerts SET status='cancelled' WHERE monitor_id=? AND status IN ('pending','failed')",
        )
        .run(id);
    });
    return json({ ok: true });
  });
}
export async function PATCH(request: NextRequest, context: Context) {
  return endpoint(async () => {
    originCheck(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    const { active } = await body(
      request,
      z.object({ active: z.boolean() }).strict(),
    );
    const result = await db()
      .prepare("UPDATE monitors SET active=?,status=? WHERE id=? AND user_id=?")
      .run(
        active ? 1 : 0,
        active ? "Aguardando próxima consulta" : "Pausado",
        id,
        user.id,
      );
    if (!result.changes)
      throw new HttpError(404, "Monitoramento não encontrado.");
    return json({ ok: true });
  });
}
export async function DELETE(request: NextRequest, context: Context) {
  return endpoint(async () => {
    originCheck(request);
    const user = await requireUser(request);
    const { id } = await context.params;
    if (
      !(
        await db()
          .prepare("DELETE FROM monitors WHERE id=? AND user_id=?")
          .run(id, user.id)
      ).changes
    )
      throw new HttpError(404, "Monitoramento não encontrado.");
    return json({ ok: true });
  });
}
