import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { rmSync } from "node:fs";
import { resolve, sep, join } from "node:path";
import { chromium } from "playwright-core";
import { db, closeDatabase } from "../lib/server/db";
import { serviceId } from "../lib/server/whatsapp-service";
import { createAuth } from "../lib/monitoring/whatsapp";

const root = resolve("data", `profile-test-${randomUUID()}`);
process.env.FASTBUS_DATA_DIR = root;
process.env.FASTBUS_DATA_KEY = randomBytes(32).toString("hex");
delete process.env.FASTBUS_CLOUD_MODE;
after(() => {
  closeDatabase();
  if (!root.startsWith(resolve("data") + sep))
    throw new Error("Unsafe test cleanup");
  rmSync(root, { recursive: true, force: true });
});
test("a closed Chromium profile round-trips through encrypted RemoteAuth backup with Local Storage, IndexedDB and cookies intact", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<title>Session fixture</title>");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port,
    origin = `http://127.0.0.1:${port}`;
  db()
    .prepare(
      "INSERT INTO whatsapp_service(id,desired,status,updated_at) VALUES (?,1,'ready',?)",
    )
    .run(serviceId, Date.now());
  let context:
    Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  const auths: ReturnType<typeof createAuth>[] = [];
  const browserOptions = {
    headless: true,
    executablePath:
      process.platform === "win32"
        ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
        : chromium.executablePath(),
    chromiumSandbox: true,
  };
  try {
    for (const restore of [false, true]) {
      const auth = createAuth(
        serviceId,
        join(root, restore ? "restored" : "original"),
      );
      auths.push(auth);
      const client = {
        options: { puppeteer: {} as { userDataDir?: string } },
        emit: () => {},
      };
      auth.setup(client as never);
      await auth.beforeBrowserInitialized();
      context = await chromium.launchPersistentContext(
        client.options.puppeteer.userDataDir!,
        browserOptions,
      );
      const page = await context.newPage();
      await page.goto(origin);
      if (!restore) {
        await context.addCookies([
          {
            name: "fixture",
            value: "preserved",
            url: origin,
            expires: Math.floor(Date.now() / 1000) + 3600,
          },
        ]);
        await page.evaluate(async () => {
          localStorage.setItem("session-fixture", "preserved");
          await new Promise<void>((done, fail) => {
            const request = indexedDB.open("session-fixture", 1);
            request.onupgradeneeded = () =>
              request.result.createObjectStore("auth");
            request.onerror = () => fail(request.error);
            request.onsuccess = () => {
              const database = request.result;
              const tx = database.transaction("auth", "readwrite");
              tx.objectStore("auth").put("preserved", "token");
              tx.oncomplete = () => {
                database.close();
                done();
              };
              tx.onerror = () => fail(tx.error);
            };
          });
        });
        const current = context;
        await auth.checkpoint(() => current.close());
        context = undefined;
      } else {
        assert.equal(
          await page.evaluate(() => localStorage.getItem("session-fixture")),
          "preserved",
        );
        assert.equal(
          (await context.cookies(origin)).find(
            (cookie) => cookie.name === "fixture",
          )?.value,
          "preserved",
        );
        const value = await page.evaluate(
          () =>
            new Promise((done, fail) => {
              const request = indexedDB.open("session-fixture", 1);
              request.onerror = () => fail(request.error);
              request.onsuccess = () => {
                const database = request.result;
                const read = database
                  .transaction("auth")
                  .objectStore("auth")
                  .get("token");
                read.onsuccess = () => {
                  done(read.result);
                  database.close();
                };
                read.onerror = () => fail(read.error);
              };
            }),
        );
        assert.equal(value, "preserved");
      }
      await auth.destroy();
    }
  } finally {
    await context?.close();
    for (const auth of auths) await auth.destroy();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
