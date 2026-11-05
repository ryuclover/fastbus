import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { verificationSchema } from "./verification-schema";
import { operationalSchema } from "./operational-schema";

export const dataDir = () => resolve(process.env.FASTBUS_DATA_DIR || "./data");
let connection: DatabaseSync | undefined;
export function closeDatabase() {
  connection?.close();
  connection = undefined;
}
export function db() {
  if (connection) return connection;
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  connection = new DatabaseSync(resolve(dataDir(), "fastbus.sqlite"));
  connection.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    PRAGMA secure_delete=ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email_hash TEXT NOT NULL UNIQUE, profile TEXT NOT NULL,
      password TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, reset_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS monitors (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      config TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, cursor INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL, checked_at INTEGER, status TEXT NOT NULL DEFAULT 'Aguardando primeira consulta',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS monitors_due ON monitors(active, next_at);
    CREATE INDEX IF NOT EXISTS monitors_owner ON monitors(user_id);
    CREATE TABLE IF NOT EXISTS whatsapp (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      desired INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'disconnected',
      qr TEXT, qr_expires INTEGER, backup TEXT, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS observations (
      monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      fingerprint TEXT NOT NULL, price REAL NOT NULL,
      PRIMARY KEY(monitor_id, fingerprint)
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL, created_at INTEGER NOT NULL, sent_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS alerts_due ON alerts(status, next_at);
    CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, next_at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL);
  `);
  // Transactional, additive migration from user-owned WhatsApp sessions to one service sender.
  connection.exec("BEGIN IMMEDIATE");
  try {
    const columns = connection.prepare("PRAGMA table_info(users)").all() as {
      name: string;
    }[];
    if (!columns.some((column) => column.name === "role")) {
      connection.exec(
        "ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin'))",
      );
      connection.exec(
        "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0",
      );
    }
    const version = (
      connection.prepare("PRAGMA user_version").get() as {
        user_version: number;
      }
    ).user_version;
    connection.exec(`
      CREATE TABLE IF NOT EXISTS notification_contacts (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        phone TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, consent_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS whatsapp_service (
        id TEXT PRIMARY KEY CHECK(id='00000000-0000-4000-8000-000000000001'),
        desired INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'disconnected',
        qr TEXT, qr_expires INTEGER, backup TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbound_gates (key TEXT PRIMARY KEY, next_at INTEGER NOT NULL);
    `);
    if (version < 2) {
      connection.exec(
        "UPDATE whatsapp SET desired=0,status='disconnected',qr=NULL,qr_expires=NULL,backup=NULL",
      );
      connection.exec("PRAGMA user_version=2");
    }
    const serviceColumns = connection
      .prepare("PRAGMA table_info(whatsapp_service)")
      .all() as { name: string }[];
    if (!serviceColumns.some((column) => column.name === "last_error")) {
      connection.exec(
        "ALTER TABLE whatsapp_service ADD COLUMN last_error TEXT",
      );
      connection.exec(
        "ALTER TABLE whatsapp_service ADD COLUMN retry_at INTEGER",
      );
    }
    connection.exec(verificationSchema);
    connection.exec(operationalSchema);
    connection.exec("PRAGMA user_version=4");
    connection.exec("COMMIT");
  } catch (error) {
    connection.exec("ROLLBACK");
    connection.close();
    connection = undefined;
    throw error;
  }
  return connection;
}
export function transaction<T>(fn: () => T): T {
  db().exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db().exec("COMMIT");
    return result;
  } catch (error) {
    db().exec("ROLLBACK");
    throw error;
  }
}
export function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const row = db()
    .prepare(
      `INSERT INTO limits(key,count,reset_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,
    reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING count`,
    )
    .get(key, now + windowMs, now, now) as { count: number };
  return row.count <= max;
}
