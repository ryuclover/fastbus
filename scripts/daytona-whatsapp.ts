import { createServer } from "node:http";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client, LocalAuth } from "whatsapp-web.js";
import QRCode from "qrcode";
import {
  daytonaHandler,
  type RemoteWhatsAppState,
} from "../lib/monitoring/daytona-protocol";
import { connectionError } from "../lib/monitoring/connection-error";
import {
  configureWhatsAppNavigation,
  installNavigationRecovery,
} from "../lib/monitoring/navigation-recovery";

async function main() {
  const secret = process.env.FASTBUS_JOB_SECRET || "";
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("INVALID_JOB_SECRET");
  const root = "/home/daytona/.fastbus/whatsapp";
  const profile = join(root, "session-fastbus");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const fixture = process.argv[2] === "smoke";
  if (process.env.FASTBUS_RESET_PROFILE === "1" && !fixture)
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  let restored = !fixture && process.env.FASTBUS_RESET_PROFILE !== "1";
  for (const part of ["IndexedDB", "Local Storage"])
    if (!(await readdir(join(profile, "Default", part)).catch(() => [])).length)
      restored = false;
  let status: RemoteWhatsAppState["status"] = fixture
    ? "fixture"
    : "connecting";
  let readySince = 0,
    qr: string | undefined,
    qrExpires = 0,
    error: string | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  const auth = new LocalAuth({ clientId: "fastbus", dataPath: root });
  const client = new Client({
    authStrategy: auth,
    userAgent: false as unknown as string,
    puppeteer: { headless: false, executablePath: "/usr/bin/chromium" },
    qrMaxRetries: 3,
    authTimeoutMs: 60000,
    webVersionCache: { type: "none" },
  });
  const afterBrowser = auth.afterBrowserInitialized.bind(auth);
  auth.afterBrowserInitialized = async () => {
    await afterBrowser();
    if (client.pupPage) configureWhatsAppNavigation(client.pupPage);
  };
  installNavigationRecovery(client);
  const stable = () =>
    status === "ready" &&
    readySince > 0 &&
    (restored || Date.now() - readySince >= 60000);
  const close = () => {
    closing = true;
    return (closePromise ||= fixture
      ? Promise.resolve()
      : client.destroy().catch(() => {}));
  };
  const requireReady = () => {
    if (closing || status !== "ready") throw new Error("WHATSAPP_NOT_READY");
  };
  let server: ReturnType<typeof createServer>;
  server = createServer(
    daytonaHandler(
      secret,
      {
        state: () => ({
          status,
          stable: stable(),
          ...(qr && qrExpires > Date.now() ? { qr, qrExpires } : {}),
          ...(error ? { error } : {}),
        }),
        number: async (phone) => {
          requireReady();
          const recipient = await client.getNumberId(phone);
          return recipient ? { _serialized: recipient._serialized } : null;
        },
        send: async (to, text) => {
          requireReady();
          await client.sendMessage(to, text, {
            linkPreview: false,
            waitUntilMsgSent: true,
          });
        },
        checkpoint: async () => {
          if (status === "saved") return;
          if (!stable()) throw new Error("SESSION_NOT_STABLE");
          await close();
          for (const part of ["IndexedDB", "Local Storage"])
            if (!(await readdir(join(profile, "Default", part))).length)
              throw new Error("SESSION_BACKUP_INCOMPLETE");
          status = "saved";
          qr = undefined;
        },
        stop: async (revoke) => {
          await close();
          if (revoke && !fixture)
            await rm(profile, { recursive: true, force: true, maxRetries: 3 });
        },
      },
      () => {
        clearTimeout(timer);
        server.close();
      },
    ),
  );
  server.requestTimeout = 10000;
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(30377, "0.0.0.0", done);
  });
  const timer = setTimeout(() => {
    void close().finally(() => server.close());
  }, 180000);
  const failed = (code: string) => {
    if (closing) return;
    status = "error";
    error = code;
    qr = undefined;
    void close();
  };
  process.on("SIGTERM", () => {
    clearTimeout(timer);
    void close().finally(() => server.close());
  });
  process.on("SIGINT", () => {
    clearTimeout(timer);
    void close().finally(() => server.close());
  });
  process.on("unhandledRejection", () => failed("BROWSER_NAVIGATION"));
  if (!fixture) {
    client.on("qr", (value) => {
      if (closing) return;
      restored = false;
      readySince = 0;
      status = "qr";
      void QRCode.toDataURL(value, { width: 280, margin: 2 }).then((image) => {
        if (!closing && status === "qr") {
          qr = image;
          qrExpires = Date.now() + 45000;
        }
      });
    });
    client.on("authenticated", () => {
      if (!closing) {
        status = "authenticated";
        qr = undefined;
      }
    });
    client.on("ready", () => {
      if (!closing) {
        status = "ready";
        readySince ||= Date.now();
        qr = undefined;
      }
    });
    client.on("auth_failure", () => failed("AUTH_FAILED"));
    client.on("disconnected", () => failed("DISCONNECTED"));
    void client
      .initialize()
      .catch((failure) => failed(connectionError(failure)));
  }
}
void main().catch(() => {
  console.error("DAYTONA_WHATSAPP_START_FAILED");
  process.exitCode = 1;
});
