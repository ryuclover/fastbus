import { NextRequest, after } from "next/server";
import { z } from "zod";
import {
  body,
  endpoint,
  HttpError,
  json,
  originCheck,
  requireAdmin,
} from "@/lib/server/http";
import {
  DiagnosticError,
  diagnosticsStatus,
  enqueueDiagnostic,
  finishDiagnostic,
} from "@/lib/monitoring/health-checks";
import { cloudMode, runCloudJob } from "@/lib/server/cloud-jobs";
import { providerIds } from "@/types/providers";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
const inputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("whatsapp") }).strict(),
  z.object({ kind: z.literal("message") }).strict(),
  z
    .object({
      kind: z.literal("provider"),
      monitorId: z.string().uuid(),
      provider: z.enum(providerIds),
    })
    .strict(),
]);
export async function GET(request: NextRequest) {
  return endpoint(async () => {
    const admin = await requireAdmin(request);
    return json(await diagnosticsStatus(admin.id));
  });
}
export async function POST(request: NextRequest) {
  return endpoint(async () => {
    originCheck(request);
    const admin = await requireAdmin(request);
    const input = await body(request, inputSchema);
    let id: string;
    try {
      id = await enqueueDiagnostic(
        admin.id,
        input.kind,
        input.kind === "provider" ? input.monitorId : undefined,
        input.kind === "provider" ? input.provider : undefined,
      );
    } catch (error) {
      if (error instanceof DiagnosticError)
        throw new HttpError(error.status, error.message);
      throw error;
    }
    if (cloudMode())
      after(async () => {
        try {
          const result = await runCloudJob("diagnostic", id);
          if (!result.started)
            await finishDiagnostic(
              id,
              "failed",
              result.reason === "network-blocked"
                ? "DAYTONA_NETWORK_BLOCKED"
                : result.reason === "busy"
                  ? "CLOUD_BUSY"
                  : "CLOUD_DAILY_LIMIT",
            );
          else await finishDiagnostic(id, "inconclusive", "CLOUD_FAILED");
        } catch {
          await finishDiagnostic(id, "inconclusive", "CLOUD_FAILED");
        }
      });
    return json({ id, state: "queued" }, 202);
  });
}
