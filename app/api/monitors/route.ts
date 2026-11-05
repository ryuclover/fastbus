import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { db, transaction } from "@/lib/server/database";
import { seal, unseal } from "@/lib/server/crypto";
import {
  body,
  endpoint,
  HttpError,
  json,
  originCheck,
  requireUser,
} from "@/lib/server/http";
import {
  monitorSchema,
  type MonitorConfig,
  type MonitorRow,
  today,
} from "@/lib/monitoring/schema";
import { supportsMonitoring } from "@/lib/monitoring/capabilities";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  return endpoint(async () => {
    const user = await requireUser(request);
    const rows = (await db()
      .prepare(
        `SELECT m.*,(SELECT MAX(q.completed_at) FROM query_runs q WHERE q.monitor_id=m.id AND q.code IN ('OK','ID_JOVEM_UNCONFIRMED')) AS last_success,
         (SELECT q.code FROM query_runs q WHERE q.monitor_id=m.id ORDER BY q.started_at DESC LIMIT 1) AS last_error
         FROM monitors m WHERE user_id=? ORDER BY created_at DESC`,
      )
      .all(user.id)) as MonitorRow[];
    const recent = (await db()
      .prepare(
        `SELECT q.monitor_id,q.provider,q.travel_date FROM query_runs q JOIN monitors m ON m.id=q.monitor_id WHERE m.user_id=? AND q.code IN ('OK','ID_JOVEM_UNCONFIRMED') AND q.completed_at>=? ORDER BY q.completed_at DESC LIMIT 2000`,
      )
      .all(user.id, Date.now() - 86400000)) as {
      monitor_id: string;
      provider: string;
      travel_date: string;
    }[];
    return json({
      monitors: rows.map((row) => {
        const config = unseal<MonitorConfig>(row.config, row.id);
        const start = config.rollingWindow
          ? today()
          : config.startDate < today()
            ? today()
            : config.startDate;
        const end = config.rollingWindow
          ? new Date(Date.parse(start) + 13 * 86400000)
              .toISOString()
              .slice(0, 10)
          : config.endDate;
        const providers = config.providers.filter((p) =>
          supportsMonitoring(p, config.benefit),
        );
        const checked = new Set(
          recent
            .filter(
              (q) =>
                q.monitor_id === row.id &&
                providers.includes(q.provider as (typeof providers)[number]) &&
                q.travel_date >= start &&
                q.travel_date <= end,
            )
            .map((q) => `${q.provider}:${q.travel_date}`),
        ).size;
        return {
          id: row.id,
          ...config,
          coverageChecked: checked,
          coverageTotal:
            Math.max(
              0,
              Math.round((Date.parse(end) - Date.parse(start)) / 86400000) + 1,
            ) * providers.length,
          active: !!row.active,
          nextAt: row.next_at,
          checkedAt: row.checked_at,
          status: row.status,
          lastSuccessAt: row.last_success || null,
          lastError:
            row.last_error && row.last_error !== "OK" ? row.last_error : null,
        };
      }),
    });
  });
}
export async function POST(request: NextRequest) {
  return endpoint(async () => {
    originCheck(request);
    const user = await requireUser(request);
    const config = await body(request, monitorSchema);
    const id = randomUUID();
    await transaction(async () => {
      const { count } = (await db()
        .prepare("SELECT COUNT(*) AS count FROM monitors WHERE user_id=?")
        .get(user.id)) as {
        count: number;
      };
      if (count >= 10)
        throw new HttpError(400, "Você pode salvar até 10 monitoramentos.");
      await db()
        .prepare(
          "INSERT INTO monitors(id,user_id,config,next_at,created_at) VALUES (?,?,?,?,?)",
        )
        .run(id, user.id, seal(config, id), Date.now(), Date.now());
    });
    return json({ id }, 201);
  });
}
