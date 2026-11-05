import { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/lib/server/database";
import { unseal } from "@/lib/server/crypto";
import {
  body,
  endpoint,
  json,
  originCheck,
  requireUser,
} from "@/lib/server/http";
import type { AlertPayload } from "@/lib/monitoring/engine";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  return endpoint(async () => {
    const user = await requireUser(request);
    const rows = (await db()
      .prepare(
        "SELECT id,payload,status,created_at,sent_at FROM alerts WHERE user_id=? ORDER BY created_at DESC LIMIT 50",
      )
      .all(user.id)) as {
      id: string;
      payload: string;
      status: string;
      created_at: number;
      sent_at: number | null;
    }[];
    return json({
      alerts: rows.map((row) => ({
        id: row.id,
        ...unseal<AlertPayload>(row.payload, row.id),
        status: row.status,
        createdAt: row.created_at,
        sentAt: row.sent_at,
      })),
    });
  });
}
export async function POST(request: NextRequest) {
  return endpoint(async () => {
    originCheck(request);
    const user = await requireUser(request);
    const { id } = await body(
      request,
      z.object({ id: z.string().uuid() }).strict(),
    );
    await db()
      .prepare(
        "UPDATE alerts SET status='pending',attempts=0,next_at=? WHERE id=? AND user_id=? AND status='failed'",
      )
      .run(Date.now(), id, user.id);
    return json({ ok: true });
  });
}
