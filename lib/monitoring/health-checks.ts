import { randomUUID } from "node:crypto";
import { db, transaction, rateLimit } from "../server/database";
import { digest, seal, unseal } from "../server/crypto";
import { serviceId, serviceStatus } from "../server/whatsapp-service";
import { getContact } from "./contact";
import { supportsMonitoring } from "./capabilities";
import { targetFor, type Query } from "./engine";
import { today, type MonitorConfig, type MonitorRow } from "./schema";
import { providerIds, type ProvedorId } from "../../types/providers";
import type {
  DiagnosticJob,
  DiagnosticKind,
  DiagnosticsStatus,
} from "../../types/diagnostics";
import { diagnosticCode } from "./diagnostics";
import { providerBackoff, providerSpacing } from "./pacing";

type JobRow = DiagnosticJob & { user_id: string; payload: string | null };
type ProviderPayload = {
  monitorId: string;
  fingerprint: string;
  config: MonitorConfig;
  provider: ProvedorId;
  date: string;
};
const maxAge = 5 * 60000;
export class DiagnosticError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function finishDiagnostic(
  id: string,
  state: DiagnosticJob["state"],
  code: string,
  offers: number | null = null,
) {
  await db()
    .prepare(
      "UPDATE diagnostic_jobs SET state=?,code=?,offers=?,completed_at=? WHERE id=? AND state IN ('queued','running')",
    )
    .run(state, code, offers, Date.now(), id);
}
export async function expireDiagnostics() {
  await db()
    .prepare(
      "UPDATE diagnostic_jobs SET state='inconclusive',code='JOB_EXPIRED',completed_at=? WHERE state IN ('queued','running') AND created_at<?",
    )
    .run(Date.now(), Date.now() - maxAge);
  await db()
    .prepare("DELETE FROM diagnostic_jobs WHERE created_at<?")
    .run(Date.now() - 30 * 86400000);
}
export async function enqueueDiagnostic(
  userId: string,
  kind: DiagnosticKind,
  monitorId?: string,
  provider?: ProvedorId,
) {
  const id = randomUUID();
  let payload: ProviderPayload | null = null;
  if (kind === "provider") {
    const monitor = (await db()
      .prepare("SELECT * FROM monitors WHERE id=? AND user_id=? AND active=1")
      .get(monitorId || "", userId)) as MonitorRow | undefined;
    if (!monitor)
      throw new DiagnosticError(
        404,
        "Selecione um monitoramento ativo da sua conta.",
      );
    const config = unseal<MonitorConfig>(monitor.config, monitor.id);
    if (
      !provider ||
      !config.providers.includes(provider) ||
      !supportsMonitoring(provider, config.benefit)
    )
      throw new DiagnosticError(
        400,
        "Escolha uma fonte compatível desta rota.",
      );
    const target = targetFor(config, monitor.cursor);
    if (!target)
      throw new DiagnosticError(400, "O período desta rota já terminou.");
    const gate = (await db()
      .prepare("SELECT next_at FROM providers WHERE id=?")
      .get(provider)) as { next_at: number } | undefined;
    if (gate && gate.next_at > Date.now())
      throw new DiagnosticError(
        409,
        "A fonte está em pausa. Aguarde o horário indicado no diagnóstico.",
      );
    payload = {
      monitorId: monitor.id,
      fingerprint: digest(monitor.config),
      config,
      provider,
      date: target.date,
    };
  } else {
    const sender = await serviceStatus();
    if (!sender.desired || !sender.sessionStored)
      throw new DiagnosticError(
        409,
        "Conecte o WhatsApp e aguarde a sessão ser salva.",
      );
    if (kind === "message" && !(await getContact(userId)).enabled)
      throw new DiagnosticError(
        409,
        "Confirme e ative seu número no painel antes de testar o envio.",
      );
  }
  await expireDiagnostics();
  await transaction(async () => {
    const pending = await db()
      .prepare(
        "SELECT id FROM diagnostic_jobs WHERE user_id=? AND state IN ('queued','running') LIMIT 1",
      )
      .get(userId);
    if (pending)
      throw new DiagnosticError(
        409,
        "Você já tem uma verificação em andamento.",
      );
    if (!(await rateLimit(`diagnostic:${userId}`, 3, 15 * 60000)))
      throw new DiagnosticError(
        429,
        "Limite de três verificações a cada 15 minutos. Aguarde.",
      );
    await db()
      .prepare(
        "INSERT INTO diagnostic_jobs(id,user_id,kind,payload,created_at) VALUES (?,?,?,?,?)",
      )
      .run(id, userId, kind, payload ? seal(payload, id) : null, Date.now());
  });
  return id;
}

/** Runs only inside the shared worker lease, never inside the web request. */
export async function runDiagnostic(
  deps: {
    query: Query;
    ready: () => boolean;
    send: (userId: string, id: string) => Promise<boolean>;
  },
  id?: string,
) {
  await expireDiagnostics();
  const job = (await db()
    .prepare(
      `SELECT * FROM diagnostic_jobs WHERE state='queued' ${id ? "AND id=?" : ""} ORDER BY created_at LIMIT 1`,
    )
    .get(...(id ? [id] : []))) as JobRow | undefined;
  if (!job) return false;
  const admin = (await db()
    .prepare("SELECT role,must_change_password FROM users WHERE id=?")
    .get(job.user_id)) as
    { role: string; must_change_password: number } | undefined;
  if (admin?.role !== "admin" || admin.must_change_password) {
    await finishDiagnostic(job.id, "failed", "ADMIN_REQUIRED");
    return true;
  }
  if (job.kind !== "provider" && !deps.ready()) return false;
  const claim = await db()
    .prepare(
      "UPDATE diagnostic_jobs SET state='running',code='RUNNING',started_at=? WHERE id=? AND state='queued'",
    )
    .run(Date.now(), job.id);
  if (!claim.changes) return false;
  try {
    if (job.kind === "whatsapp") {
      const sender = await serviceStatus();
      await finishDiagnostic(
        job.id,
        sender.desired ? "passed" : "failed",
        sender.desired ? "WHATSAPP_READY" : "PAIRING_REQUIRED",
      );
    } else if (job.kind === "message") {
      if (!(await getContact(job.user_id)).enabled) {
        await finishDiagnostic(job.id, "failed", "CONTACT_NOT_VERIFIED");
      } else {
        const sent = await deps.send(job.user_id, job.id);
        await finishDiagnostic(
          job.id,
          sent ? "passed" : "inconclusive",
          sent ? "MESSAGE_SENT" : "SEND_DEFERRED",
        );
      }
    } else {
      const payload = unseal<ProviderPayload>(job.payload!, job.id);
      const monitor = (await db()
        .prepare(
          "SELECT config FROM monitors WHERE id=? AND user_id=? AND active=1",
        )
        .get(payload.monitorId, job.user_id)) as { config: string } | undefined;
      if (
        !monitor ||
        digest(monitor.config) !== payload.fingerprint ||
        payload.date < today()
      ) {
        await finishDiagnostic(job.id, "failed", "MONITOR_CHANGED");
        return true;
      }
      // The same durable gate/backoff is shared with scheduled monitoring.
      const gate = (await db()
        .prepare(
          `INSERT INTO providers(id,next_at) VALUES (?,?)
        ON CONFLICT(id) DO UPDATE SET next_at=excluded.next_at WHERE providers.next_at<=? RETURNING failures`,
        )
        .get(payload.provider, Date.now() + providerSpacing(), Date.now())) as
        { failures: number } | undefined;
      if (!gate) {
        await finishDiagnostic(job.id, "inconclusive", "PROVIDER_COOLDOWN");
        return true;
      }
      let code = "QUERY_FAILED",
        state: DiagnosticJob["state"] = "failed",
        offers: number | null = null;
      let failures = gate.failures + 1,
        nextAt = Date.now() + providerBackoff(failures);
      try {
        const response = await deps.query(
          payload.config,
          payload.provider,
          payload.date,
        );
        const result = response.result;
        if (
          response.blockedUntil ||
          (result.error && result.error !== "ID_JOVEM_UNCONFIRMED")
        ) {
          code = diagnosticCode(new Error(result.error || "PROVIDER_BLOCKED"));
          nextAt = Math.max(nextAt, response.blockedUntil || 0);
        } else {
          failures = 0;
          nextAt = Date.now() + providerSpacing();
          offers = result.resultados.length;
          code =
            result.error === "ID_JOVEM_UNCONFIRMED"
              ? result.error
              : response.limited
                ? "PROVIDER_PARTIAL"
                : offers
                  ? "PROVIDER_OK"
                  : "PROVIDER_EMPTY";
          state =
            response.limited || result.error || !result.disponivel
              ? "inconclusive"
              : "passed";
        }
      } catch (error) {
        code = diagnosticCode(error);
      }
      await db()
        .prepare("UPDATE providers SET failures=?,next_at=? WHERE id=?")
        .run(failures, nextAt, payload.provider);
      await finishDiagnostic(job.id, state, code, offers);
    }
  } catch (error) {
    // A failed send may already have reached WhatsApp: never automatically retry it.
    await finishDiagnostic(
      job.id,
      "inconclusive",
      diagnosticCode(error, "CHECK_FAILED"),
    );
  }
  return true;
}

export async function diagnosticsStatus(
  userId: string,
): Promise<DiagnosticsStatus> {
  await db().prepare("SELECT 1 AS ok").get();
  const sender = await serviceStatus();
  const contact = await getContact(userId);
  const jobs = (await db()
    .prepare(
      "SELECT id,kind,state,code,offers,created_at,completed_at,payload FROM diagnostic_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 15",
    )
    .all(userId)) as (DiagnosticJob & { payload: string | null })[];
  const gates = (await db().prepare("SELECT * FROM providers").all()) as {
    id: string;
    next_at: number;
  }[];
  const runs = (await db()
    .prepare(
      "SELECT provider,code,completed_at FROM query_runs WHERE monitor_id IN (SELECT id FROM monitors WHERE user_id=?) ORDER BY started_at DESC LIMIT 200",
    )
    .all(userId)) as {
    provider: string;
    code: string;
    completed_at: number | null;
  }[];
  const monitors = (await db()
    .prepare(
      "SELECT * FROM monitors WHERE user_id=? AND active=1 ORDER BY created_at",
    )
    .all(userId)) as MonitorRow[];
  return {
    checkedAt: Date.now(),
    database: true,
    cloud: process.env.FASTBUS_CLOUD_MODE === "daily",
    cloudConfigured:
      [
        "TURSO_DATABASE_URL",
        "TURSO_AUTH_TOKEN",
        "FASTBUS_DATA_KEY",
        "BLOB_READ_WRITE_TOKEN",
        ...(process.env.FASTBUS_WHATSAPP_RUNTIME === "daytona"
          ? ["DAYTONA_API_KEY", "DAYTONA_SANDBOX_ID"]
          : ["FASTBUS_SANDBOX_SNAPSHOT"]),
      ].every((name) => !!process.env[name]) &&
      process.env.FASTBUS_DAYTONA_NETWORK_BLOCKED !== "1",
    sender: {
      status: sender.status,
      sessionStored: sender.sessionStored,
      workerOnline: sender.workerOnline,
      desired: sender.desired,
      persistent: sender.persistent,
    },
    contact: { enabled: contact.enabled, verified: contact.verified },
    queue: (await db()
      .prepare(
        "SELECT status,COUNT(*) AS count FROM alerts WHERE user_id=? GROUP BY status",
      )
      .all(userId)) as { status: string; count: number }[],
    providers: providerIds.map((id) => {
      const run = runs.find((row) => row.provider === id);
      return {
        id,
        nextAt: gates.find((row) => row.id === id)?.next_at || 0,
        lastCode: run?.code || null,
        lastAt: run?.completed_at || null,
        commercial: supportsMonitoring(id, "any"),
        youth: supportsMonitoring(id, "id100"),
      };
    }),
    monitors: monitors.flatMap((row) => {
      const config = unseal<MonitorConfig>(row.config, row.id);
      const target = targetFor(config, row.cursor);
      return target
        ? [
            {
              id: row.id,
              label: `${config.origin.replace("::", " / ")} → ${config.destination.replace("::", " / ")}`,
              providers: config.providers.filter((p) =>
                supportsMonitoring(p, config.benefit),
              ),
              date: target.date,
            },
          ]
        : [];
    }),
    jobs: jobs.map(({ payload: encrypted, ...job }) => {
      if (encrypted) {
        const payload = unseal<ProviderPayload>(encrypted, job.id);
        job.target = `${payload.provider} · ${payload.config.origin.replace("::", " / ")} → ${payload.config.destination.replace("::", " / ")} · ${payload.date}`;
      }
      return ["queued", "running"].includes(job.state) &&
        job.created_at < Date.now() - maxAge
        ? { ...job, state: "inconclusive", code: "JOB_EXPIRED" }
        : job;
    }),
  };
}
