import { timingSafeEqual } from "node:crypto";
import { runCloudJob } from "@/lib/server/cloud-jobs";
import { json } from "@/lib/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;
export async function GET(request: Request) {
  const expected = process.env.CRON_SECRET
    ? Buffer.from(`Bearer ${process.env.CRON_SECRET}`)
    : null;
  const received = Buffer.from(request.headers.get("authorization") || "");
  if (
    !expected ||
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  )
    return json({ error: "Não autorizado." }, 401);
  try {
    return json(await runCloudJob("monitor"));
  } catch {
    return json(
      {
        error:
          "A execução não foi concluída. Verifique a configuração e as cotas do plano gratuito.",
      },
      503,
    );
  }
}
