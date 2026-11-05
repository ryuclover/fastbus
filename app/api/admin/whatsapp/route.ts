import { NextRequest, after } from "next/server";
import { cloudMode, runCloudJob } from "@/lib/server/cloud-jobs";
import { deleteSessionBackup } from "@/lib/server/session-backup";
import { z } from "zod";
import { db, rateLimit } from "@/lib/server/database";
import {
  body,
  endpoint,
  HttpError,
  json,
  originCheck,
  requireAdmin,
} from "@/lib/server/http";
import { serviceId, serviceStatus } from "@/lib/server/whatsapp-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  return endpoint(async () => {
    await requireAdmin(request);
    return json(await serviceStatus(true));
  });
}
export async function POST(request: NextRequest) {
  return endpoint(async () => {
    originCheck(request);
    const admin = await requireAdmin(request);
    const { connect, retry } = await body(
      request,
      z
        .object({
          connect: z.boolean(),
          // Accepted for older tabs, but administrative session now authorizes this action.
          password: z.string().max(128).optional(),
          retry: z.boolean().optional(),
        })
        .strict(),
    );
    if (!(await rateLimit(`admin-wa:${admin.id}`, 5, 15 * 60000)))
      throw new HttpError(429, "Aguarde 15 minutos para tentar novamente.");
    const existing = (await db()
      .prepare("SELECT desired,status,backup FROM whatsapp_service WHERE id=?")
      .get(serviceId)) as
      | {
          desired: number;
          status: string;
          backup: string | null;
        }
      | undefined;
    if (
      connect &&
      existing?.desired &&
      ["connecting", "authenticated", "qr", "ready"].includes(existing.status)
    ) {
      if (!retry) return json({ ok: true });
      if (existing.status === "ready")
        throw new HttpError(
          409,
          "O WhatsApp já está conectado. Desconecte antes de iniciar uma nova sessão.",
        );
    }
    await db()
      .prepare(
        `INSERT INTO whatsapp_service(id,desired,status,updated_at) VALUES (?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET desired=excluded.desired,status=excluded.status,qr=NULL,qr_expires=NULL,
      backup=CASE WHEN excluded.desired=0 THEN NULL ELSE whatsapp_service.backup END,last_error=NULL,retry_at=NULL,updated_at=excluded.updated_at`,
      )
      .run(
        serviceId,
        connect ? 1 : 0,
        connect ? "queued" : cloudMode() ? "disconnected" : "disconnecting",
        Date.now(),
      );
    if (!connect) await deleteSessionBackup(existing?.backup).catch(() => {});
    if (connect && cloudMode())
      after(async () => {
        try {
          await runCloudJob("pair");
        } catch {
          console.error("[FastBus] Falha na execução de pareamento.");
        }
      });
    return json({ ok: true });
  });
}
