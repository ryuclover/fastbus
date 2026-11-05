import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { DatabaseSync } from "node:sqlite";
import { resolve, join } from "node:path";
import { existsSync, readdirSync } from "node:fs";
const directory = resolve(process.env.FASTBUS_DATA_DIR || "./data");
const db = new DatabaseSync(join(directory, "fastbus.sqlite"), {
  readOnly: !process.argv.includes("--retry"),
});
if (process.argv.includes("--retry"))
  db.prepare(
    "UPDATE whatsapp_service SET status='queued',last_error=NULL,retry_at=NULL,updated_at=? WHERE desired=1 AND status<>'ready'",
  ).run(Date.now());
const now = Date.now();
const sender = db
  .prepare(
    "SELECT id,desired,status,updated_at,qr IS NOT NULL AS has_qr,qr_expires,backup IS NOT NULL AS has_backup FROM whatsapp_service",
  )
  .all();
const leases = db.prepare("SELECT id,expires_at FROM leases").all();
console.log(
  JSON.stringify(
    {
      now: new Date(now).toISOString(),
      dataDirectory: directory,
      sender: sender.map((row) => ({
        ...row,
        updatedAgoSeconds: Math.round((now - Number(row.updated_at)) / 1000),
      })),
      leases: leases.map((row) => ({
        ...row,
        remainingSeconds: Math.round((Number(row.expires_at) - now) / 1000),
      })),
      monitors: db
        .prepare("SELECT COUNT(*) AS count FROM monitors WHERE active=1")
        .get(),
      chromeConfigured: !!process.env.WHATSAPP_CHROME_PATH,
      chromeExists: existsSync(process.env.WHATSAPP_CHROME_PATH || ""),
      runtimeFolders: existsSync(join(directory, "runtime"))
        ? readdirSync(join(directory, "runtime"))
        : [],
    },
    null,
    2,
  ),
);
db.close();
