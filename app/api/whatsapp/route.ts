import { NextRequest, after } from "next/server";
import { z } from "zod";
import { db, rateLimit, transaction } from "@/lib/server/database";
import {
  requestContact,
  confirmContact,
  VerificationError,
} from "@/lib/monitoring/contact-verification";
import { cloudMode, runCloudJob } from "@/lib/server/cloud-jobs";
import {
  body,
  endpoint,
  HttpError,
  json,
  originCheck,
  requireUser,
} from "@/lib/server/http";
import { contactSchema, getContact } from "@/lib/monitoring/contact";
import { serviceStatus } from "@/lib/server/whatsapp-service";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
async function verificationAction<T>(action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof VerificationError)
      throw new HttpError(error.status, error.message);
    throw error;
  }
}
export async function GET(request: NextRequest) {
  return endpoint(async () => {
    const user = await requireUser(request);
    const sender = await serviceStatus();
    return json({
      ...(await getContact(user.id)),
      senderReady: sender.cloud
        ? sender.sessionStored && sender.status !== "error"
        : sender.workerOnline && sender.status === "ready",
      cloud: sender.cloud,
      workerOnline: sender.workerOnline,
    });
  });
}
export async function POST(request: NextRequest) {
  return endpoint(async () => {
    originCheck(request);
    const user = await requireUser(request);
    if (!(await rateLimit(`contact:${user.id}`, 10, 3600000)))
      throw new HttpError(
        429,
        "Muitas alterações de número. Aguarde uma hora.",
      );
    const input = await body(request, contactSchema);
    const result = await verificationAction(() =>
      requestContact(user.id, input.phone, input.enabled),
    );
    const sender = await serviceStatus();
    if (
      result.verificationRequired &&
      cloudMode() &&
      sender.sessionStored &&
      sender.status !== "error"
    )
      after(async () => {
        const failed = async () => {
          await db()
            .prepare(
              "UPDATE contact_verifications SET status='failed',code=NULL,code_hash=NULL WHERE id=? AND status='pending'",
            )
            .run(result.challengeId!);
        };
        try {
          const job = await runCloudJob("verify");
          if (!job.started) await failed();
        } catch {
          await failed().catch(() => {});
          console.error("[FastBus] Falha no envio da confirmação.");
        }
      });
    return json({
      ok: true,
      verificationRequired: result.verificationRequired,
      senderReady: sender.cloud
        ? sender.sessionStored && sender.status !== "error"
        : sender.workerOnline && sender.status === "ready",
    });
  });
}
export async function DELETE(request: NextRequest) {
  return endpoint(async () => {
    originCheck(request);
    const user = await requireUser(request);
    await transaction(async () => {
      await db()
        .prepare("DELETE FROM notification_contacts WHERE user_id=?")
        .run(user.id);
      await db()
        .prepare("DELETE FROM contact_verifications WHERE user_id=?")
        .run(user.id);
    });
    return json({ ok: true });
  });
}
export async function PATCH(request: NextRequest) {
  return endpoint(async () => {
    originCheck(request);
    const user = await requireUser(request);
    const input = await body(
      request,
      z.object({ code: z.string().regex(/^\d{4}$/) }).strict(),
    );
    await verificationAction(() => confirmContact(user.id, input.code));
    if (cloudMode())
      after(async () => {
        try {
          await runCloudJob("deliver");
        } catch {
          console.error("[FastBus] Falha ao retomar avisos.");
        }
      });
    return json({ ok: true });
  });
}
