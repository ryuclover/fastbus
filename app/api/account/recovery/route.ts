import { NextRequest, after } from "next/server";
import { z } from "zod";
import {
  body,
  endpoint,
  json,
  originCheck,
  HttpError,
} from "@/lib/server/http";
import {
  requestRecovery,
  resetPassword,
} from "@/lib/monitoring/account-recovery";
import { VerificationError } from "@/lib/monitoring/contact-verification";
import { cloudMode, runCloudJob } from "@/lib/server/cloud-jobs";
export const runtime = "nodejs";
export const maxDuration = 300;
const email = z
  .string()
  .trim()
  .email()
  .max(254)
  .transform((value) => value.toLowerCase());
async function safe<T>(action: () => Promise<T>) {
  try {
    return await action();
  } catch (error) {
    if (error instanceof VerificationError)
      throw new HttpError(error.status, error.message);
    throw error;
  }
}
export async function POST(request: NextRequest) {
  return endpoint(async () => {
    originCheck(request);
    const input = await body(request, z.object({ email }).strict());
    const queued = await safe(() => requestRecovery(input.email));
    if (queued && cloudMode())
      after(async () => {
        try {
          await runCloudJob("verify");
        } catch {
          console.error("[FastBus] Falha na execução de recuperação.");
        }
      });
    return json({
      ok: true,
      message:
        "Se a conta tiver um WhatsApp confirmado, enviaremos um código. Caso ainda não tenha confirmado o número, contate o administrador.",
    });
  });
}
export async function PATCH(request: NextRequest) {
  return endpoint(async () => {
    originCheck(request);
    const input = await body(
      request,
      z
        .object({
          email,
          code: z.string().regex(/^\d{8}$/),
          password: z.string().min(12).max(128),
        })
        .strict(),
    );
    await safe(() => resetPassword(input.email, input.code, input.password));
    return json({ ok: true });
  });
}
