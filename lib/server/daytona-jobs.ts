import { Daytona } from "@daytona/sdk";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { db } from "./database";
import { seal } from "./crypto";
import { serviceId } from "./whatsapp-service";
import { claimWorker, releaseWorker } from "../monitoring/lease";
import { runDiagnostic, finishDiagnostic } from "../monitoring/health-checks";
import { drainAlerts } from "../monitoring/engine";
import { deliverVerification } from "../monitoring/contact-verification";
import { deliverRecovery } from "../monitoring/account-recovery";
import {
  sendTestWithTransport,
  sendWithTransport,
} from "../monitoring/whatsapp";
import { withDaytonaChannel } from "./daytona-transport";
export const daytonaWhatsApp = () =>
  process.env.FASTBUS_WHATSAPP_RUNTIME === "daytona";
export const daytonaConfigured = () =>
  !!process.env.DAYTONA_API_KEY && !!process.env.DAYTONA_SANDBOX_ID;

/** Database, consent and rate checks stay in Vercel; Olympus only runs WhatsApp. */
export async function runDaytonaJob(
  mode: string,
  diagnosticId: string | undefined,
  deadline = Date.now() + 260000,
) {
  if (process.env.FASTBUS_DAYTONA_NETWORK_BLOCKED === "1")
    throw new Error("DAYTONA_NETWORK_BLOCKED");
  if (!/^(pair|verify|deliver|diagnostic)$/.test(mode) || !daytonaConfigured())
    throw new Error("DAYTONA_CONFIGURATION_REQUIRED");
  const owner = randomUUID();
  if (!(await claimWorker(owner))) {
    if (diagnosticId)
      await finishDiagnostic(diagnosticId, "failed", "CLOUD_BUSY");
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
  const fail = async (code: string) => {
    await db()
      .prepare(
        "UPDATE whatsapp_service SET status='error',last_error=?,qr=NULL,qr_expires=NULL,updated_at=? WHERE id=? AND desired=1",
      )
      .run(code, Date.now(), serviceId);
    if (diagnosticId)
      await finishDiagnostic(diagnosticId, "inconclusive", code);
  };
  try {
    const initial = (await db()
      .prepare("SELECT desired,backup FROM whatsapp_service WHERE id=?")
      .get(serviceId)) as
      { desired: number; backup: string | null } | undefined;
    if (!initial?.desired) return;
    const marker = `daytona:${process.env.DAYTONA_SANDBOX_ID}`;
    const client = new Daytona({
      apiKey: process.env.DAYTONA_API_KEY,
      requestTimeoutMs: 20000,
      otelEnabled: false,
    });
    const sandbox = await client.get(process.env.DAYTONA_SANDBOX_ID!);
    await db()
      .prepare(
        "UPDATE whatsapp_service SET status='connecting',last_error=CASE WHEN backup=? THEN NULL ELSE 'PERSISTENT_PAIRING_REQUIRED' END,qr=NULL,qr_expires=NULL,updated_at=? WHERE id=? AND desired=1",
      )
      .run(marker, Date.now(), serviceId);
    await withDaytonaChannel(
      sandbox,
      await readFile(
        join(process.cwd(), ".fastbus-cloud", "daytona-whatsapp.cjs"),
      ),
      initial.backup !== marker,
      mode,
      deadline,
      async (channel) => {
        const transport = {
          getNumberId: async (phone: string) => {
            if (lostLease) throw new Error("WORKER_LEASE_LOST");
            return channel.transport.getNumberId(phone);
          },
          sendMessage: async (
            to: string,
            text: string,
            options: { linkPreview: boolean; waitUntilMsgSent: boolean },
          ) => {
            if (lostLease) throw new Error("WORKER_LEASE_LOST");
            return channel.transport.sendMessage(to, text, options);
          },
        };
        const until = Math.min(deadline - 30000, Date.now() + 165000);
        let diagnosticDone = false,
          lastQr = "",
          handledDelivery = false;
        while (!lostLease && Date.now() < until) {
          const current = (await db()
            .prepare("SELECT desired FROM whatsapp_service WHERE id=?")
            .get(serviceId)) as { desired: number } | undefined;
          if (!current?.desired) {
            await channel.stop(true);
            return;
          }
          const state = await channel.state();
          if (state.status === "error") {
            await fail(state.error || "INITIALIZATION_FAILED");
            return;
          }
          if (state.status === "qr" && state.qr && state.qr !== lastQr) {
            lastQr = state.qr;
            await db()
              .prepare(
                "UPDATE whatsapp_service SET status='qr',qr=?,qr_expires=?,last_error='PERSISTENT_PAIRING_REQUIRED',retry_at=NULL,updated_at=? WHERE id=? AND desired=1",
              )
              .run(
                seal(state.qr, serviceId),
                Math.min(state.qrExpires || 0, Date.now() + 45000),
                Date.now(),
                serviceId,
              );
          } else if (
            state.status === "authenticated" ||
            state.status === "ready"
          ) {
            await db()
              .prepare(
                "UPDATE whatsapp_service SET status=?,qr=NULL,qr_expires=NULL,retry_at=NULL,updated_at=? WHERE id=? AND desired=1",
              )
              .run(state.status, Date.now(), serviceId);
          }
          if (diagnosticId && !diagnosticDone) {
            await db()
              .prepare(
                "UPDATE diagnostic_jobs SET code='RESTORING_SESSION' WHERE id=? AND state='queued'",
              )
              .run(diagnosticId);
            diagnosticDone = await runDiagnostic(
              {
                ready: () => state.status === "ready",
                send: (userId, id) =>
                  sendTestWithTransport(transport, userId, id),
                query: async () => {
                  throw new Error("INVALID_DIAGNOSTIC_KIND");
                },
              },
              diagnosticId,
            );
          }
          if (state.status === "ready") {
            if (!diagnosticId && !handledDelivery) {
              const sent =
                (await deliverVerification(transport)) ||
                (await deliverRecovery(transport));
              if (mode !== "pair")
                await drainAlerts(
                  (id, payload) => sendWithTransport(transport, id, payload),
                  Math.min(until - 10000, Date.now() + 30000),
                );
              handledDelivery = true;
              if (sent) await delay(3000);
            }
            if (state.stable) {
              await channel.checkpoint();
              if (lostLease) return;
              const saved = await db()
                .prepare(
                  "UPDATE whatsapp_service SET backup=?,status='sleeping',last_error=NULL,qr=NULL,qr_expires=NULL,retry_at=NULL,updated_at=? WHERE id=? AND desired=1 AND backup IS ?",
                )
                .run(marker, Date.now(), serviceId, initial.backup);
              if (!saved.changes) await channel.stop(true);
              return;
            }
          }
          await delay(2000);
        }
        if (!lostLease)
          await fail(lastQr ? "PAIRING_REQUIRED" : "WHATSAPP_NOT_READY");
      },
    );
  } catch (error) {
    if (!lostLease)
      await fail(
        error instanceof Error && /^[A-Z_]{1,70}$/.test(error.message)
          ? error.message
          : "DAYTONA_WORKER_FAILED",
      );
    throw error;
  } finally {
    clearInterval(heartbeat);
    await releaseWorker(owner);
  }
}
