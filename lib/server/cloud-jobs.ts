import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Sandbox } from "@vercel/sandbox";
import { db, rateLimit } from "./database";
import { serviceId } from "./whatsapp-service";
import { deleteSessionBackup } from "./session-backup";
import {
  daytonaWhatsApp,
  daytonaConfigured,
  runDaytonaJob,
} from "./daytona-jobs";

export const cloudMode = () => process.env.FASTBUS_CLOUD_MODE === "daily";
export async function runCloudJob(
  mode: "pair" | "monitor" | "verify" | "deliver" | "diagnostic" | "search",
  diagnosticId?: string,
) {
  const deadline = Date.now() + 260000;
  const result = await executeCloudJob(mode, diagnosticId, deadline);
  if (mode === "monitor" && result.started && daytonaWhatsApp()) {
    const pending = await db()
      .prepare(
        "SELECT 1 FROM alerts WHERE status='pending' AND next_at<=? UNION ALL SELECT 1 FROM contact_verifications WHERE status='pending' AND expires_at>? LIMIT 1",
      )
      .get(Date.now(), Date.now());
    if (pending) await executeCloudJob("deliver", undefined, deadline);
  }
  return result;
}
async function executeCloudJob(
  mode: "pair" | "monitor" | "verify" | "deliver" | "diagnostic" | "search",
  diagnosticId?: string,
  deadline = Date.now() + 260000,
) {
  if (!cloudMode()) throw new Error("Cloud runtime unavailable");
  let providerRuntime = mode === "monitor" || mode === "search";
  if (mode === "diagnostic") {
    if (!diagnosticId || !/^[a-f0-9-]{36}$/.test(diagnosticId))
      throw new Error("Invalid diagnostic job");
    const job = (await db()
      .prepare("SELECT kind FROM diagnostic_jobs WHERE id=?")
      .get(diagnosticId)) as { kind: string } | undefined;
    if (!job) throw new Error("Missing diagnostic job");
    providerRuntime = job.kind === "provider";
  }
  const useDaytona = daytonaWhatsApp() && !providerRuntime;
  if (useDaytona && process.env.FASTBUS_DAYTONA_NETWORK_BLOCKED === "1") {
    if (mode === "pair")
      await db()
        .prepare(
          "UPDATE whatsapp_service SET status='error',last_error='DAYTONA_NETWORK_BLOCKED',qr=NULL,qr_expires=NULL,updated_at=? WHERE id=? AND desired=1",
        )
        .run(Date.now(), serviceId);
    return { started: false, reason: "network-blocked" };
  }
  if (useDaytona ? !daytonaConfigured() : !process.env.FASTBUS_SANDBOX_SNAPSHOT)
    throw new Error("Cloud runtime unavailable");
  const owner = randomUUID();
  const now = Date.now();
  const claim = async () =>
    (await db()
      .prepare(
        `INSERT INTO leases(id,owner,expires_at) VALUES ('cloud-job',?,?)
    ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,expires_at=excluded.expires_at
    WHERE leases.expires_at<? RETURNING owner`,
      )
      .get(owner, Date.now() + 330000, Date.now())) as
      { owner: string } | undefined;
  let lease = await claim();
  const waitUntil = now + 60000;
  while (
    lease?.owner !== owner &&
    (mode === "verify" || mode === "deliver") &&
    Date.now() < waitUntil
  ) {
    await delay(2000);
    lease = await claim();
  }
  if (lease?.owner !== owner) {
    if (mode === "pair")
      await db()
        .prepare(
          "UPDATE whatsapp_service SET status='error',last_error='CLOUD_BUSY',updated_at=? WHERE id=? AND desired=1 AND status='queued'",
        )
        .run(Date.now(), serviceId);
    return { started: false, reason: "busy" };
  }
  let sandbox: Sandbox | undefined;
  try {
    // Bound browser starts even when an administrator repeatedly reconnects.
    const day = new Date().toISOString().slice(0, 10);
    if (
      !(await rateLimit(
        `cloud:${mode}:${day}`,
        mode === "pair" || mode === "diagnostic" || mode === "search"
          ? 3
          : mode === "monitor"
            ? 1
            : 10,
        86400000,
      ))
    ) {
      if (mode === "pair")
        await db()
          .prepare(
            "UPDATE whatsapp_service SET status='error',last_error='CLOUD_DAILY_LIMIT',qr=NULL,qr_expires=NULL,updated_at=? WHERE id=? AND desired=1",
          )
          .run(Date.now(), serviceId);
      return { started: false, reason: "daily-limit" };
    }
    const env: Record<string, string> = {
      FASTBUS_CLOUD_MODE: "daily",
      FASTBUS_RUNTIME_DIR: "/tmp/fastbus",
      CLICKBUS_TRANSPORT: "browser",
      CLICKBUS_NETWORK_MODE: process.env.CLICKBUS_NETWORK_MODE || "extension",
      CLICKBUS_BROWSER_HEADLESS: "false",
      CLICKBUS_BROWSEC_EXTENSION_PATH: "browsec",
      PLAYWRIGHT_BROWSERS_PATH: "/opt/fastbus-browsers",
      NODE_ENV: "production",
      CLICKBUS_FREE_VPN_ROTATION:
        process.env.CLICKBUS_FREE_VPN_ROTATION === "1" ? "1" : "0",
    };
    if (mode === "diagnostic") {
      if (!diagnosticId || !/^[a-f0-9-]{36}$/.test(diagnosticId))
        throw new Error("Invalid diagnostic job");
      env.FASTBUS_DIAGNOSTIC_ID = diagnosticId;
    }
    if (mode === "search") {
      if (!diagnosticId || !/^[a-f0-9-]{36}$/.test(diagnosticId))
        throw new Error("Invalid search job");
      env.FASTBUS_SEARCH_ID = diagnosticId;
      env.FASTBUS_QUERY_ONLY = "1";
    }
    if (providerRuntime && daytonaWhatsApp()) env.FASTBUS_QUERY_ONLY = "1";
    for (const name of [
      "TURSO_DATABASE_URL",
      "TURSO_AUTH_TOKEN",
      "FASTBUS_DATA_KEY",
      "BLOB_READ_WRITE_TOKEN",
    ]) {
      const value = process.env[name];
      if (!value) throw new Error("Missing cloud credential");
      env[name] = value;
    }
    if (useDaytona) {
      const previous = (await db()
        .prepare("SELECT backup FROM whatsapp_service WHERE id=?")
        .get(serviceId)) as { backup: string | null } | undefined;
      await runDaytonaJob(mode, diagnosticId, deadline);
      const current = (await db()
        .prepare("SELECT backup FROM whatsapp_service WHERE id=?")
        .get(serviceId)) as { backup: string | null } | undefined;
      if (
        current?.backup === `daytona:${process.env.DAYTONA_SANDBOX_ID}` &&
        previous?.backup !== current.backup
      )
        await deleteSessionBackup(previous?.backup).catch(() => {});
      return { started: true };
    }
    sandbox = await Sandbox.create({
      source: {
        type: "snapshot",
        snapshotId: process.env.FASTBUS_SANDBOX_SNAPSHOT!,
      },
      timeout: 200000,
      persistent: false,
      resources: { vcpus: 2 },
      env,
    });
    await sandbox.writeFiles(
      await Promise.all(
        [
          "worker.cjs",
          ...(providerRuntime && env.CLICKBUS_NETWORK_MODE === "extension"
            ? ["browsec.tar.gz"]
            : []),
        ].map(async (name) => ({
          path: name,
          content: await readFile(join(process.cwd(), ".fastbus-cloud", name)),
        })),
      ),
    );
    const command = await sandbox.runCommand({
      cmd: "sh",
      args: [
        "-c",
        (providerRuntime && env.CLICKBUS_NETWORK_MODE === "extension"
          ? "tar -xzf browsec.tar.gz && "
          : "") +
          'export CLICKBUS_BROWSER_PATH="$(node -e \'process.stdout.write(require("playwright-core").chromium.executablePath())\')" && export WHATSAPP_CHROME_PATH="$CLICKBUS_BROWSER_PATH" && dbus-run-session -- xvfb-run -a node worker.cjs "$1"',
        "fastbus",
        mode,
      ],
    });
    if (command.exitCode !== 0) throw new Error("Cloud execution failed");
    return { started: true };
  } catch (error) {
    if (mode === "pair")
      await db()
        .prepare(
          "UPDATE whatsapp_service SET status='error',last_error=CASE WHEN status='error' AND last_error IS NOT NULL THEN last_error ELSE 'INITIALIZATION_FAILED' END,qr=NULL,qr_expires=NULL,updated_at=? WHERE id=? AND desired=1",
        )
        .run(Date.now(), serviceId);
    throw error;
  } finally {
    await sandbox?.stop().catch(() => {});
    await db()
      .prepare("DELETE FROM leases WHERE id='cloud-job' AND owner=?")
      .run(owner);
  }
}
