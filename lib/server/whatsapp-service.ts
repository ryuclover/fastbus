import { db } from "./database";
import { unseal } from "./crypto";
import { connectionMessages } from "../monitoring/connection-error";
export const serviceId = "00000000-0000-4000-8000-000000000001";
export async function finishWhatsAppExecution() {
  await db()
    .prepare(
      "UPDATE whatsapp_service SET status=CASE WHEN status IN ('error','qr','connecting','authenticated') THEN 'error' WHEN backup IS NOT NULL THEN 'sleeping' ELSE 'error' END,last_error=CASE WHEN status='qr' THEN COALESCE(last_error,'RESTORE_REQUIRES_PAIRING') WHEN backup IS NULL THEN COALESCE(last_error,'PAIRING_REQUIRED') ELSE last_error END,qr=NULL,qr_expires=NULL,updated_at=? WHERE desired=1",
    )
    .run(Date.now());
}
export async function workerOnline() {
  const row = (await db()
    .prepare("SELECT expires_at FROM leases WHERE id='worker'")
    .get()) as
    | {
        expires_at: number;
      }
    | undefined;
  return !!row && row.expires_at > Date.now();
}
export async function serviceStatus(includeQr = false) {
  const row = (await db()
    .prepare(
      "SELECT desired,status,backup AS backup_ref,backup IS NOT NULL AS has_backup,qr,qr_expires,last_error,retry_at,updated_at FROM whatsapp_service WHERE id=?",
    )
    .get(serviceId)) as
    | {
        desired: number;
        status: string;
        has_backup: number;
        backup_ref: string | null;
        qr: string | null;
        qr_expires: number;
        last_error: string | null;
        retry_at: number | null;
        updated_at: number;
      }
    | undefined;
  return {
    cloud: process.env.FASTBUS_CLOUD_MODE === "daily",
    persistent: process.env.FASTBUS_WHATSAPP_RUNTIME === "daytona",
    sessionStored:
      !!row?.has_backup &&
      !!row.desired &&
      (process.env.FASTBUS_WHATSAPP_RUNTIME !== "daytona" ||
        row.backup_ref === `daytona:${process.env.DAYTONA_SANDBOX_ID}`) &&
      ![
        "SESSION_BACKUP_INCOMPLETE",
        "SESSION_BACKUP_INVALID",
        "SESSION_BACKUP_FAILED",
        "RESTORE_REQUIRES_PAIRING",
        "PERSISTENT_PAIRING_REQUIRED",
      ].includes(row.last_error || ""),
    status: row?.status || "disconnected",
    desired: !!row?.desired,
    workerOnline: await workerOnline(),
    ...(includeQr
      ? {
          error: row?.last_error
            ? connectionMessages[row.last_error] ||
              connectionMessages.INITIALIZATION_FAILED
            : null,
          retryAt: row?.retry_at || null,
          updatedAt: row?.updated_at || null,
          qr:
            row?.desired && row.qr && row.qr_expires > Date.now()
              ? unseal<string>(row.qr, serviceId)
              : null,
        }
      : {}),
  };
}
