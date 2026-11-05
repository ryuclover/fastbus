import { NextRequest, after } from "next/server";
import { z } from "zod";
import {
  body,
  endpoint,
  json,
  originCheck,
  requireUser,
} from "@/lib/server/http";
import { monitorSchema } from "@/lib/monitoring/schema";
import {
  enqueueSearch,
  finishSearch,
  listSearches,
} from "@/lib/monitoring/manual-search";
import { cloudMode, runCloudJob } from "@/lib/server/cloud-jobs";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: NextRequest) {
  return endpoint(async () => {
    const user = await requireUser(request);
    return json({ searches: await listSearches(user.id) });
  });
}
export async function POST(request: NextRequest) {
  return endpoint(async () => {
    originCheck(request);
    const user = await requireUser(request);
    const input = await body(
      request,
      z.union([
        z
          .object({
            config: monitorSchema.refine(
              (config) => !config.rollingWindow,
              "A busca manual aceita até 7 dias fixos.",
            ),
          })
          .strict(),
        z.object({ id: z.string().uuid() }).strict(),
      ]),
    );
    const id = await enqueueSearch(user.id, input);
    if (cloudMode())
      after(async () => {
        try {
          const result = await runCloudJob("search", id);
          await finishSearch(
            id,
            result.started
              ? "JOB_INTERRUPTED"
              : result.reason === "busy"
                ? "CLOUD_BUSY"
                : "CLOUD_DAILY_LIMIT",
          );
        } catch {
          await finishSearch(id, "CLOUD_FAILED");
        }
      });
    return json({ id }, 202);
  });
}
