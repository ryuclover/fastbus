import { AsyncLocalStorage } from "node:async_hooks";
import { verificationSchema } from "./verification-schema";
import { operationalSchema } from "./operational-schema";
import {
  createClient,
  type Client,
  type InValue,
  type Transaction,
} from "@libsql/client";
import {
  db as localDatabase,
  dataDir,
  closeDatabase as closeLocal,
} from "./db";

export { dataDir };
type Remote = Client | Transaction;
const context = new AsyncLocalStorage<Remote | "local">();
let client: Client | undefined;
let initialized: Promise<void> | undefined;
let queue = Promise.resolve();

// Local transactions must also be serialized across await boundaries.
async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const previous = queue;
  let release!: () => void;
  queue = new Promise<void>((done) => {
    release = done;
  });
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function remoteClient(): Promise<Client | undefined> {
  if (!process.env.TURSO_DATABASE_URL) {
    if (process.env.VERCEL)
      throw new Error(
        "Configure o banco remoto antes de usar o FastBus na Vercel.",
      );
    return undefined;
  }
  client ??= createClient({
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });
  initialized ??= client
    .batch(
      cloudSchema
        .split(";")
        .map((sql) => sql.trim())
        .filter(Boolean),
      "write",
    )
    .then(() => {});
  await initialized;
  return client;
}

async function execute(
  sql: string,
  args: InValue[],
  method: "get" | "all" | "run",
) {
  const active = context.getStore();
  const remote = active && active !== "local" ? active : await remoteClient();
  if (remote) {
    const result = await remote.execute({ sql, args });
    return method === "get"
      ? result.rows[0]
      : method === "all"
        ? result.rows
        : {
            changes: result.rowsAffected,
            lastInsertRowid: result.lastInsertRowid,
          };
  }
  const perform = async () => {
    const statement = localDatabase().prepare(sql);
    // The local adapter only receives SQLite-compatible values from application code.
    const values = args as Parameters<typeof statement.run>;
    if (method === "get") return statement.get(...values);
    if (method === "all") return statement.all(...values);
    const result = statement.run(...values);
    return {
      changes: Number(result.changes),
      lastInsertRowid: result.lastInsertRowid,
    };
  };
  return active === "local" ? perform() : exclusive(perform);
}

export function db() {
  return {
    prepare(sql: string) {
      return {
        get: (...args: InValue[]): Promise<unknown> =>
          execute(sql, args, "get"),
        all: (...args: InValue[]): Promise<unknown> =>
          execute(sql, args, "all"),
        run: async (...args: InValue[]) =>
          (await execute(sql, args, "run")) as {
            changes: number;
            lastInsertRowid?: bigint;
          },
      };
    },
  };
}

export async function transaction<T>(operation: () => Promise<T>): Promise<T> {
  if (context.getStore()) throw new Error("Nested database transaction");
  const remote = await remoteClient();
  if (remote) {
    const tx = await remote.transaction("write");
    try {
      const result = await context.run(tx, operation);
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      tx.close();
    }
  }
  return exclusive(async () => {
    const local = localDatabase();
    local.exec("BEGIN IMMEDIATE");
    try {
      const result = await context.run("local", operation);
      local.exec("COMMIT");
      return result;
    } catch (error) {
      local.exec("ROLLBACK");
      throw error;
    }
  });
}

export async function rateLimit(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const row = (await db()
    .prepare(
      `INSERT INTO limits(key,count,reset_at) VALUES (?,1,?)
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN reset_at<=? THEN 1 ELSE count+1 END,
    reset_at=CASE WHEN reset_at<=? THEN excluded.reset_at ELSE reset_at END RETURNING count`,
    )
    .get(key, now + windowMs, now, now)) as { count: number };
  return row.count <= max;
}

export function closeDatabase() {
  client?.close();
  client = undefined;
  initialized = undefined;
  closeLocal();
}

// Fresh cloud databases use explicit schema versions instead of SQLite file PRAGMAs.
const cloudSchema =
  operationalSchema +
  verificationSchema +
  `
CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email_hash TEXT NOT NULL UNIQUE, profile TEXT NOT NULL,
 password TEXT NOT NULL, created_at INTEGER NOT NULL,
 role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
 must_change_password INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY,count INTEGER NOT NULL,reset_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS monitors (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,config TEXT NOT NULL,
 active INTEGER NOT NULL DEFAULT 1,cursor INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,checked_at INTEGER,
 status TEXT NOT NULL DEFAULT 'Aguardando primeira consulta',created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS monitors_due ON monitors(active,next_at);
CREATE INDEX IF NOT EXISTS monitors_owner ON monitors(user_id);
CREATE TABLE IF NOT EXISTS observations (monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,fingerprint TEXT NOT NULL,price REAL NOT NULL,PRIMARY KEY(monitor_id,fingerprint));
CREATE TABLE IF NOT EXISTS alerts (
 id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,monitor_id TEXT NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
 payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,created_at INTEGER NOT NULL,sent_at INTEGER
);
CREATE INDEX IF NOT EXISTS alerts_due ON alerts(status,next_at);
CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY,next_at INTEGER NOT NULL,failures INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY,owner TEXT NOT NULL,expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS notification_contacts (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,phone TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 0,consent_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS whatsapp_service (
 id TEXT PRIMARY KEY CHECK(id='00000000-0000-4000-8000-000000000001'),desired INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'disconnected',
 qr TEXT,qr_expires INTEGER,backup TEXT,updated_at INTEGER NOT NULL,last_error TEXT,retry_at INTEGER
);
CREATE TABLE IF NOT EXISTS outbound_gates (key TEXT PRIMARY KEY,next_at INTEGER NOT NULL);
INSERT INTO _schema_version(version) VALUES (1) ON CONFLICT DO NOTHING;
`;
