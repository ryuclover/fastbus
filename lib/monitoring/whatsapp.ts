import { alertIsCurrent } from "./alert-validity";
import { priceInReais } from "../money";
import { readFile, writeFile, mkdir, rm, readdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Client, RemoteAuth } from "whatsapp-web.js";
import QRCode from "qrcode";
import { archiveSessionProfile, assertSessionArchive } from "./session-profile";
import { db, dataDir, transaction } from "../server/database";
import { seal, unseal, emailIndex } from "../server/crypto";
import { serviceId } from "../server/whatsapp-service";
import { getContact, phoneSchema } from "./contact";
import { DeliveryUncertain, type AlertPayload } from "./engine";
import { connectionError } from "./connection-error";
import { deliverVerification } from "./contact-verification";
import { deliverRecovery } from "./account-recovery";
import {
  saveSessionBackup,
  readSessionBackup,
  deleteSessionBackup,
} from "../server/session-backup";
import {
  installNavigationRecovery,
  configureWhatsAppNavigation,
} from "./navigation-recovery";
const clients = new Map<
  string,
  {
    client: Client;
    ready: boolean;
    checkpoint: () => Promise<void>;
    stable: () => boolean;
    closing: boolean;
    watchdog?: ReturnType<typeof setTimeout>;
  }
>();
const stopping = new Map<string, Promise<void>>();
const retryAt = new Map<string, number>();
export const authSessionName = "RemoteAuth-fastbus";
const runtimeRoot = () =>
  resolve(process.env.FASTBUS_RUNTIME_DIR || join(dataDir(), "runtime"));
const runtimeFor = (id: string) => {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid client ID");
  const root = runtimeRoot();
  // Avoid repeating the UUID twice: Chromium IndexedDB files otherwise exceed Windows path limits.
  const target = resolve(root, id === serviceId ? "sender" : id);
  if (!target.startsWith(root + sep))
    throw new Error("Unsafe runtime directory");
  return target;
};
async function desired(id: string) {
  if (id !== serviceId) return false;
  return !!(
    (await db()
      .prepare("SELECT desired FROM whatsapp_service WHERE id=?")
      .get(id)) as
      | {
          desired: number;
        }
      | undefined
  )?.desired;
}
async function status(id: string, value: string) {
  await db()
    .prepare(
      "UPDATE whatsapp_service SET status=?,qr=NULL,qr_expires=NULL,last_error=CASE WHEN last_error IN ('SESSION_BACKUP_INCOMPLETE','RESTORE_REQUIRES_PAIRING','PERSISTENT_PAIRING_REQUIRED') THEN last_error ELSE NULL END,retry_at=NULL,updated_at=? WHERE id=? AND desired=1",
    )
    .run(value, Date.now(), id);
}
async function failed(id: string, code: string) {
  const next = Date.now() + 5 * 60000;
  retryAt.set(id, next);
  await db()
    .prepare(
      "UPDATE whatsapp_service SET status='error',qr=NULL,qr_expires=NULL,last_error=?,retry_at=?,updated_at=? WHERE id=? AND desired=1",
    )
    .run(code, next, Date.now(), id);
}
export class EncryptedWhatsAppStore {
  restored = false;
  constructor(
    private id: string,
    private directory: string,
  ) {}
  private check(session: string) {
    if (this.id !== serviceId || session !== authSessionName)
      throw new Error("Session ownership mismatch");
  }
  async sessionExists({ session }: { session: string }) {
    this.check(session);
    const row = (await db()
      .prepare("SELECT backup FROM whatsapp_service WHERE id=? AND desired=1")
      .get(this.id)) as
      | {
          backup: string;
        }
      | undefined;
    if (!row?.backup) return false;
    try {
      const archive = Buffer.from(
        unseal<string>(await readSessionBackup(row.backup), this.id),
        "base64",
      );
      await assertSessionArchive(archive);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "SESSION_BACKUP_INCOMPLETE"
      ) {
        await db()
          .prepare(
            "UPDATE whatsapp_service SET last_error='SESSION_BACKUP_INCOMPLETE' WHERE id=?",
          )
          .run(this.id);
        return false;
      }
      throw error;
    }
  }
  async save({ session }: { session: string }) {
    this.check(session);
    const archive = await readFile(join(this.directory, `${session}.zip`));
    await assertSessionArchive(archive);
    const previous = (await db()
      .prepare("SELECT backup FROM whatsapp_service WHERE id=? AND desired=1")
      .get(this.id)) as { backup: string | null } | undefined;
    if (!previous) return;
    const encrypted = seal(archive.toString("base64"), this.id);
    const backup =
      process.env.FASTBUS_CLOUD_MODE === "daily"
        ? await saveSessionBackup(encrypted)
        : encrypted;
    try {
      const result = await db()
        .prepare(
          "UPDATE whatsapp_service SET backup=?,last_error=NULL WHERE id=? AND desired=1",
        )
        .run(backup, this.id);
      if (!result.changes) {
        await deleteSessionBackup(backup);
        return;
      }
    } catch (error) {
      await deleteSessionBackup(backup).catch(() => {});
      throw error;
    }
    await deleteSessionBackup(previous.backup).catch(() => {});
  }
  async extract({ session, path }: { session: string; path: string }) {
    this.check(session);
    if (resolve(path) !== resolve(this.directory, `${session}.zip`))
      throw new Error("Invalid archive path");
    const row = (await db()
      .prepare("SELECT backup FROM whatsapp_service WHERE id=? AND desired=1")
      .get(this.id)) as
      | {
          backup: string;
        }
      | undefined;
    if (!row?.backup) throw new Error("Session unavailable");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(
      path,
      Buffer.from(
        unseal<string>(await readSessionBackup(row.backup), this.id),
        "base64",
      ),
      { mode: 0o600 },
    );
    this.restored = true;
  }
  async delete({ session }: { session: string }) {
    this.check(session);
    const previous = (await db()
      .prepare("SELECT backup FROM whatsapp_service WHERE id=?")
      .get(this.id)) as { backup: string | null } | undefined;
    await db()
      .prepare("UPDATE whatsapp_service SET backup=NULL WHERE id=?")
      .run(this.id);
    await deleteSessionBackup(previous?.backup);
  }
}
/** Serialize backups and cancel them on logout/shutdown, including the first delayed save. */
export function createAuth(id: string, directory: string) {
  const store = new EncryptedWhatsAppStore(id, directory);
  const auth = new RemoteAuth({
    clientId: "fastbus",
    dataPath: directory,
    backupSyncIntervalMs: 60000,
    store,
  });
  const archiveAuth = auth as RemoteAuth & {
    storeRemoteSession(options?: { emit?: boolean }): Promise<void>;
    userDataDir: string;
    tempDir: string;
    sessionName: string;
    compressSession(): Promise<string>;
  };
  archiveAuth.compressSession = () =>
    archiveSessionProfile(
      archiveAuth.userDataDir,
      archiveAuth.tempDir,
      join(directory, `${archiveAuth.sessionName}.zip`),
    );
  const originalDestroy = auth.destroy.bind(auth);
  const originalDisconnect = auth.disconnect.bind(auth);
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<void> | null = null;
  let readySince = 0;
  const schedule = () => {
    if (closed) return;
    timer = setTimeout(() => {
      if (closed) return;
      pending = archiveAuth
        .storeRemoteSession({ emit: true })
        .catch(() => {
          console.error(
            "[FastBus] Falha no backup do WhatsApp; nova tentativa em um minuto.",
          );
        })
        .finally(() => {
          pending = null;
          schedule();
        });
    }, 60000);
  };
  const cancel = async () => {
    closed = true;
    clearTimeout(timer);
    await pending;
  };
  auth.afterAuthReady = async () => {
    readySince = Date.now();
    schedule();
  };
  auth.destroy = async () => {
    await cancel();
    await originalDestroy();
  };
  auth.disconnect = async () => {
    await cancel();
    await originalDisconnect();
  };
  return Object.assign(auth, {
    pairingRequired: () => {
      store.restored = false;
      readySince = 0;
    },
    stable: () =>
      store.restored || (readySince > 0 && Date.now() - readySince >= 60000),
    checkpoint: async (flush?: () => Promise<void>) => {
      if (closed) return;
      clearTimeout(timer);
      if (pending) await pending;
      if (closed) return;
      clearTimeout(timer);
      // Graceful Chromium shutdown flushes Local Storage/LevelDB before the final snapshot.
      if (flush) await flush();
      pending = archiveAuth.storeRemoteSession({ emit: true });
      try {
        await pending;
      } finally {
        pending = null;
        schedule();
      }
    },
  });
}
async function stop(id: string, logout = false) {
  const pending = stopping.get(id);
  if (pending) return pending;
  const task = stopClient(id, logout);
  stopping.set(id, task);
  try {
    await task;
  } finally {
    stopping.delete(id);
  }
}
async function stopClient(id: string, logout = false) {
  const entry = clients.get(id);
  if (entry) {
    clients.delete(id);
    clearTimeout(entry.watchdog);
    entry.ready = false;
    try {
      if (logout) await entry.client.logout();
    } catch {
      /* browser may already be closed */
    }
    try {
      await entry.client.destroy();
    } catch {
      /* disconnected browser */
    }
  }
  const target = runtimeFor(id);
  await rm(target, { recursive: true, force: true, maxRetries: 3 });
  await db()
    .prepare(
      "UPDATE whatsapp_service SET status='disconnected',qr=NULL,qr_expires=NULL,backup=NULL,updated_at=? WHERE id=? AND desired=0",
    )
    .run(Date.now(), id);
}
async function start(id: string) {
  await stopping.get(id);
  const directory = runtimeFor(id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const auth = createAuth(id, directory);
  const client = new Client({
    authStrategy: auth,
    // The library defaults to Chrome 101; use the installed browser's actual user agent.
    // Runtime explicitly supports false; 1.34.7's declaration still only accepts string.
    userAgent: false as unknown as string,
    puppeteer: {
      headless: process.env.FASTBUS_CLOUD_MODE !== "daily",
      executablePath: process.env.WHATSAPP_CHROME_PATH || undefined,
    },
    qrMaxRetries: 3,
    authTimeoutMs: 60000,
    webVersionCache: { type: "none" },
  });
  const browserInitialized = auth.afterBrowserInitialized.bind(auth);
  auth.afterBrowserInitialized = async () => {
    await browserInitialized();
    if (client.pupPage) configureWhatsAppNavigation(client.pupPage);
  };
  installNavigationRecovery(client);
  const entry: {
    client: Client;
    ready: boolean;
    checkpoint: () => Promise<void>;
    stable: () => boolean;
    closing: boolean;
    watchdog?: ReturnType<typeof setTimeout>;
  } = {
    client,
    ready: false,
    closing: false,
    stable: auth.stable,
    checkpoint: () =>
      auth.checkpoint(async () => {
        entry.closing = true;
        entry.ready = false;
        await client.pupBrowser?.close();
      }),
  };
  const current = () => clients.get(id) === entry && !entry.closing;
  const safely = (action: () => Promise<void>) => () => {
    void action().catch(() => {
      console.error(
        "[FastBus] Não foi possível persistir o estado da conexão.",
      );
      void stop(id).catch(() => {});
    });
  };
  clients.set(id, entry);
  await status(id, "connecting");
  entry.watchdog = setTimeout(
    safely(async () => {
      if (!current() || entry.ready) return;
      await failed(id, "CONNECTION_TIMEOUT");
      void stop(id).catch(() => {});
    }),
    90000,
  );
  client.on("qr", (qr: string) => {
    auth.pairingRequired();
    if (!current()) return;
    clearTimeout(entry.watchdog);
    void QRCode.toDataURL(qr, { width: 280, margin: 2 })
      .then(async (image) => {
        if (clients.get(id) !== entry) return;
        await db()
          .prepare(
            "UPDATE whatsapp_service SET status='qr',qr=?,qr_expires=?,last_error=CASE WHEN backup IS NOT NULL THEN COALESCE(last_error,'RESTORE_REQUIRES_PAIRING') ELSE NULL END,retry_at=NULL,updated_at=? WHERE id=? AND desired=1",
          )
          .run(seal(image, id), Date.now() + 60000, Date.now(), id);
      })
      .catch(() => status(id, "error").catch(() => {}));
  });
  client.on(
    "authenticated",
    safely(async () => {
      if (current()) await status(id, "authenticated");
    }),
  );
  client.on(
    "ready",
    safely(async () => {
      if (!current()) return;
      clearTimeout(entry.watchdog);
      entry.ready = true;
      await status(id, "ready");
    }),
  );
  client.on(
    "auth_failure",
    safely(async () => {
      if (!current()) return;
      entry.ready = false;
      await failed(id, "AUTH_FAILED");
      void stop(id).catch(() => {});
    }),
  );
  client.on(
    "disconnected",
    safely(async () => {
      if (!current()) return;
      entry.ready = false;
      await failed(id, "DISCONNECTED");
      void stop(id).catch(() => {});
    }),
  );
  void client
    .initialize()
    .then(async () => {
      if (!current()) await client.destroy().catch(() => {});
    })
    .catch(async (error: unknown) => {
      if (!current()) return;
      console.error(
        "[FastBus] Falha ao iniciar WhatsApp:",
        error instanceof Error
          ? error.message.split("\n")[0]
          : "Erro de inicialização",
      );
      await failed(id, connectionError(error));
      await stop(id).catch(() => {});
    })
    .catch(() => {
      console.error("[FastBus] Não foi possível registrar a falha de conexão.");
    });
}
export async function syncWhatsApp() {
  // Deletion/disconnection is processed before starting clients or sending messages.
  for (const id of clients.keys())
    if (!(await desired(id))) await stop(id, true);
  // Clean profiles orphaned by account deletion while the worker was stopped.
  const directories = await readdir(runtimeRoot(), {
    withFileTypes: true,
  }).catch(() => []);
  for (const directory of directories) {
    if (directory.isDirectory() && directory.name === serviceId) {
      const root = runtimeRoot();
      const legacy = resolve(root, serviceId);
      if (!legacy.startsWith(root + sep))
        throw new Error("Unsafe legacy runtime directory");
      await rm(legacy, { recursive: true, force: true, maxRetries: 3 });
      continue;
    }
    if (
      directory.isDirectory() &&
      /^[a-f0-9-]{36}$/.test(directory.name) &&
      !(await desired(directory.name))
    )
      await stop(directory.name);
  }
  const rows = (await db()
    .prepare("SELECT id,status,retry_at FROM whatsapp_service WHERE desired=1")
    .all()) as {
    id: string;
    status: string;
    retry_at: number | null;
  }[];
  for (const { id, status: state, retry_at } of rows) {
    if (state === "queued") {
      retryAt.delete(id);
      if (clients.has(id)) await stop(id);
    }
    if (
      clients.has(id) ||
      Math.max(retryAt.get(id) || 0, state === "queued" ? 0 : retry_at || 0) >
        Date.now()
    )
      continue;
    // Bound browser use; additional accounts remain queued until a slot is available.
    if (clients.size >= 1) break;
    try {
      await start(id);
    } catch (error: unknown) {
      console.error(
        "[FastBus] Falha ao preparar WhatsApp:",
        error instanceof Error
          ? error.message.split("\n")[0]
          : "Erro de preparação",
      );
      await failed(id, connectionError(error));
    }
  }
  await db()
    .prepare(
      "UPDATE whatsapp_service SET status='disconnected',qr=NULL,qr_expires=NULL WHERE desired=0",
    )
    .run();
}
const lastSent = new Map<string, number>();
export async function sendAlert(userId: string, payload: AlertPayload) {
  const entry = clients.get(serviceId);
  if (
    !entry?.ready ||
    !(await desired(serviceId)) ||
    !entry.client.info?.wid ||
    Date.now() - (lastSent.get(userId) || 0) < 60000
  )
    return false;
  return sendWithTransport(entry.client, userId, payload);
}
export async function checkpointWhatsApp() {
  for (const entry of clients.values())
    if (entry.ready) {
      try {
        await entry.checkpoint();
      } catch (error) {
        await failed(
          serviceId,
          connectionError(error) === "INITIALIZATION_FAILED"
            ? "SESSION_BACKUP_FAILED"
            : connectionError(error),
        );
        throw error;
      }
    }
}
export function whatsAppReady() {
  return clients.get(serviceId)?.ready === true;
}
export function whatsAppSessionStable() {
  const entry = clients.get(serviceId);
  return !!entry?.ready && entry.stable();
}
export async function sendVerification() {
  const entry = clients.get(serviceId);
  if (!entry?.ready || !entry.client.info?.wid) return false;
  return (
    (await deliverVerification(entry.client)) ||
    (await deliverRecovery(entry.client))
  );
}
export async function sendDiagnosticMessage(userId: string, id: string) {
  const entry = clients.get(serviceId);
  if (!entry?.ready || !entry.client.info?.wid) return false;
  return sendTestWithTransport(entry.client, userId, id);
}
export type AlertTransport = {
  getNumberId(number: string): Promise<{
    _serialized: string;
  } | null>;
  sendMessage(
    id: string,
    message: string,
    options: {
      linkPreview: boolean;
      waitUntilMsgSent: boolean;
    },
  ): Promise<unknown>;
};
export async function sendWithTransport(
  transport: AlertTransport,
  userId: string,
  payload: AlertPayload,
) {
  const money = new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(priceInReais(payload));
  const route = `${payload.origin.replace("::", " / ")} → ${payload.destination.replace("::", " / ")}`;
  const priceLabel =
    payload.provider === "ClickBus" && payload.benefit.startsWith("id_jovem_")
      ? `Tarifa informada: ${money}\nTaxas e valor final a confirmar no ClickBus.`
      : payload.evidence?.totalMinor != null
        ? `Total informado: ${money}`
        : `Cotação: ${money} · total a confirmar na fonte.`;
  const message = `FastBus • oportunidade encontrada\n${route}\n${payload.date} às ${payload.departure}\n${payload.company} • ${payload.provider}\n${priceLabel}${payload.benefit === "id_jovem_100" ? " • ID Jovem 100%" : payload.benefit === "id_jovem_50" ? " • ID Jovem 50%" : ""}\nConsultado em ${new Date(payload.observedAt).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}\n${payload.url}\nPreço e disponibilidade podem mudar. Confirme as condições na fonte.`;
  return sendTextWithTransport(transport, userId, message, () =>
    alertIsCurrent(payload),
  );
}
export async function sendTestWithTransport(
  transport: AlertTransport,
  userId: string,
  id: string,
) {
  return sendTextWithTransport(
    transport,
    userId,
    `FastBus • teste de envio\nEsta é uma mensagem de verificação solicitada na administração. Não é uma oferta de passagem.\nReferência: ${id}\n${new Date().toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}`,
  );
}
async function sendTextWithTransport(
  transport: AlertTransport,
  userId: string,
  message: string,
  valid = () => true,
) {
  if (!valid() || !(await desired(serviceId))) return false;
  const contact = await getContact(userId);
  if (!contact.enabled || !phoneSchema.safeParse(contact.phone).success)
    return false;
  const recipient = await transport.getNumberId(contact.phone.slice(1));
  if (!recipient || !recipient._serialized.endsWith("@c.us"))
    throw new Error("RECIPIENT_NOT_ON_WHATSAPP");
  // Recheck opt-in after the asynchronous number lookup, before transmitting travel details.
  const current = await getContact(userId);
  if (
    !current.enabled ||
    current.phone !== contact.phone ||
    !(await desired(serviceId))
  )
    return false;
  const gates = [
    `recipient:${emailIndex(`recipient:${contact.phone}`)}`,
    `user:${userId}`,
    "sender:global",
  ];
  const reserved = await transaction(async () => {
    if (!valid()) return false;
    const now = Date.now();
    for (const key of gates) {
      const row = (await db()
        .prepare("SELECT next_at FROM outbound_gates WHERE key=?")
        .get(key)) as
        | {
            next_at: number;
          }
        | undefined;
      if (row && row.next_at > now) return false;
    }
    for (const key of gates)
      await db()
        .prepare(
          "INSERT INTO outbound_gates(key,next_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET next_at=excluded.next_at",
        )
        .run(key, now + (key === "sender:global" ? 5000 : 60000));
    return true;
  });
  if (!reserved || !valid()) return false;
  try {
    await transport.sendMessage(recipient._serialized, message, {
      linkPreview: false,
      waitUntilMsgSent: true,
    });
  } catch (cause) {
    throw new DeliveryUncertain("Envio sem confirmação do WhatsApp", { cause });
  }
  lastSent.set(userId, Date.now());
  return true;
}
export async function closeWhatsApp() {
  for (const [id, entry] of clients) {
    clearTimeout(entry.watchdog);
    try {
      await entry.client.destroy();
    } catch {
      /* browser already closed */
    }
    await rm(runtimeFor(id), {
      recursive: true,
      force: true,
      maxRetries: 3,
    }).catch(() => {});
  }
  clients.clear();
}
