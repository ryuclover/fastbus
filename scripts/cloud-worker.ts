import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { db, closeDatabase } from "../lib/server/database";
import { claimWorker, releaseWorker } from "../lib/monitoring/lease";
import { runSearchJob, finishSearch } from "../lib/monitoring/manual-search";
import { queryProvider } from "../lib/monitoring/query-provider";
import {
  runOneQuery,
  drainAlerts,
  expireAlerts,
} from "../lib/monitoring/engine";
import {
  syncWhatsApp,
  sendAlert,
  closeWhatsApp,
  checkpointWhatsApp,
  sendVerification,
  whatsAppReady,
  whatsAppSessionStable,
  sendDiagnosticMessage,
} from "../lib/monitoring/whatsapp";
import {
  runDiagnostic,
  finishDiagnostic,
} from "../lib/monitoring/health-checks";
import { closeClickBusBrowser } from "../lib/scrapers/clickbus/browser";
import { closeProviderProxies } from "../lib/monitoring/proxy";
import {
  serviceId,
  finishWhatsAppExecution,
} from "../lib/server/whatsapp-service";

async function main() {
  if (
    !process.env.TURSO_DATABASE_URL ||
    process.env.FASTBUS_CLOUD_MODE !== "daily"
  )
    throw new Error("Cloud configuration required");
  const mode = process.argv[2];
  if (
    mode !== "pair" &&
    mode !== "monitor" &&
    mode !== "verify" &&
    mode !== "deliver" &&
    mode !== "diagnostic" &&
    mode !== "search"
  )
    throw new Error("Invalid job");
  const owner = randomUUID();
  if (!(await claimWorker(owner))) {
    if (mode === "search" && process.env.FASTBUS_SEARCH_ID)
      await finishSearch(process.env.FASTBUS_SEARCH_ID, "CLOUD_BUSY");
    if (mode === "diagnostic" && process.env.FASTBUS_DIAGNOSTIC_ID)
      await finishDiagnostic(
        process.env.FASTBUS_DIAGNOSTIC_ID,
        "failed",
        "CLOUD_BUSY",
      );
    await closeDatabase();
    return;
  }
  let lostLease = false;
  const heartbeat = setInterval(() => {
    void claimWorker(owner)
      .then((ok) => {
        lostLease ||= !ok;
      })
      .catch(() => {
        lostLease = true;
      });
  }, 10000);
  const duration = Number(process.env.FASTBUS_JOB_DURATION_MS || 165000);
  const deadline =
    Date.now() + Math.min(165000, Math.max(30000, duration || 165000));
  try {
    if (mode === "search") {
      if (!process.env.FASTBUS_SEARCH_ID) throw new Error("Missing search job");
      await runSearchJob(
        queryProvider,
        process.env.FASTBUS_SEARCH_ID,
        deadline - 15000,
        () => !lostLease,
      );
      return;
    }
    if (mode === "diagnostic") {
      const id = process.env.FASTBUS_DIAGNOSTIC_ID;
      if (!id) throw new Error("Missing diagnostic job");
      const job = (await db()
        .prepare(
          "SELECT kind FROM diagnostic_jobs WHERE id=? AND state='queued'",
        )
        .get(id)) as { kind: string } | undefined;
      if (!job) return;
      while (!lostLease && Date.now() < deadline - 10000) {
        if (job.kind !== "provider") {
          const state = (await db()
            .prepare("SELECT desired,backup FROM whatsapp_service WHERE id=?")
            .get(serviceId)) as
            { desired: number; backup: string | null } | undefined;
          if (!state?.desired || !state.backup) {
            await finishDiagnostic(id, "failed", "PAIRING_REQUIRED");
            return;
          }
          await syncWhatsApp();
          await db()
            .prepare(
              "UPDATE diagnostic_jobs SET code='RESTORING_SESSION' WHERE id=? AND state='queued'",
            )
            .run(id);
        }
        if (
          await runDiagnostic(
            {
              query: queryProvider,
              ready: whatsAppReady,
              send: sendDiagnosticMessage,
            },
            id,
          )
        ) {
          // A restore check can require pairing when the legacy archive is incomplete.
          // Keep that newly authenticated browser alive for the initial storage sync.
          while (
            !lostLease &&
            whatsAppReady() &&
            !whatsAppSessionStable() &&
            Date.now() < deadline - 10000
          ) {
            await delay(2000);
          }
          if (whatsAppSessionStable()) await checkpointWhatsApp();
          return;
        }
        await delay(2000);
      }
      await finishDiagnostic(id, "inconclusive", "WHATSAPP_NOT_READY");
      return;
    }
    await expireAlerts();
    if (mode === "monitor") {
      await runOneQuery(queryProvider);
      await closeClickBusBrowser();
      if (process.env.FASTBUS_QUERY_ONLY === "1") return;
      const pending = await db()
        .prepare(
          "SELECT id FROM alerts WHERE status='pending' AND next_at<=? LIMIT 1",
        )
        .get(Date.now());
      const verification = await db()
        .prepare(
          "SELECT user_id FROM contact_verifications WHERE status='pending' AND expires_at>? UNION ALL SELECT user_id FROM password_recovery WHERE status='pending' AND expires_at>? LIMIT 1",
        )
        .get(Date.now(), Date.now());
      if (!pending && !verification) return;
    }
    while (!lostLease && Date.now() < deadline) {
      const state = (await db()
        .prepare(
          "SELECT desired,status,backup FROM whatsapp_service WHERE id=?",
        )
        .get(serviceId)) as
        { desired: number; status: string; backup: string | null } | undefined;
      if (!state?.desired) break;
      await syncWhatsApp();
      if (whatsAppReady()) {
        const verificationSent = await sendVerification();
        if (verificationSent) await delay(5000);
        if (mode !== "pair") {
          await drainAlerts(
            sendAlert,
            Math.min(deadline - 10000, Date.now() + 30000),
          );
          const pending = await db()
            .prepare(
              `SELECT 1 FROM contact_verifications WHERE status='pending' AND expires_at>?
           UNION ALL SELECT 1 FROM password_recovery WHERE status='pending' AND expires_at>?
           UNION ALL SELECT 1 FROM alerts a JOIN notification_contacts c ON c.user_id=a.user_id AND c.enabled=1
           JOIN contact_verifications v ON v.user_id=c.user_id AND v.phone=c.phone AND v.status='verified'
           JOIN monitors m ON m.id=a.monitor_id AND m.active=1 WHERE a.status='pending' AND a.next_at<? LIMIT 1`,
            )
            .get(Date.now(), Date.now(), deadline - 10000);
          if (pending && Date.now() < deadline - 15000) {
            await delay(5000);
            continue;
          }
          if (whatsAppSessionStable()) {
            await checkpointWhatsApp();
            break;
          }
        }
        if (whatsAppSessionStable()) {
          await checkpointWhatsApp();
          break;
        }
      }
      await delay(2000);
    }
  } finally {
    await closeClickBusBrowser().catch(() => {});
    await closeProviderProxies().catch(() => {});
    if (!lostLease && whatsAppSessionStable())
      await checkpointWhatsApp().catch(() => {});
    else if (!lostLease && whatsAppReady())
      await db()
        .prepare(
          "UPDATE whatsapp_service SET status='error',last_error='SESSION_BACKUP_FAILED' WHERE id=? AND desired=1",
        )
        .run(serviceId);
    await closeWhatsApp().catch(() => {});
    clearInterval(heartbeat);
    if (!lostLease) {
      if (process.env.FASTBUS_QUERY_ONLY !== "1")
        await finishWhatsAppExecution();
      await releaseWorker(owner);
    }
    await closeDatabase();
  }
}
void main().catch(() => {
  console.error(
    "[FastBus] Cloud job failed; details withheld to protect credentials.",
  );
  process.exitCode = 1;
});
