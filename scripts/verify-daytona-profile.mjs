// Artificial browser-storage fixture only. Never opens WhatsApp or uses account credentials.
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert/strict";
import puppeteer from "puppeteer";
const directory = await mkdtemp("/home/daytona/fastbus/profile-fixture-");
const server = createServer((_req, res) =>
  res.end("<title>FastBus storage fixture</title>"),
);
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  for (const restore of [false, true]) {
    browser = await puppeteer.launch({
      executablePath: "/usr/bin/chromium",
      headless: true,
      userDataDir: join(directory, "profile"),
    });
    const page = await browser.newPage();
    await page.goto(origin);
    if (!restore) {
      await page.evaluate(async () => {
        localStorage.setItem("fastbus-fixture", "preserved");
        document.cookie = "fixture=preserved; Max-Age=3600; SameSite=Strict";
        await new Promise((done, fail) => {
          const r = indexedDB.open("fastbus-fixture", 1);
          r.onupgradeneeded = () => r.result.createObjectStore("store");
          r.onerror = () => fail(Error("fixture"));
          r.onsuccess = () => {
            const tx = r.result.transaction("store", "readwrite");
            tx.objectStore("store").put("preserved", "key");
            tx.oncomplete = () => {
              r.result.close();
              done();
            };
          };
        });
      });
    } else {
      assert.equal(
        await page.evaluate(() => localStorage.getItem("fastbus-fixture")),
        "preserved",
      );
      assert.equal(
        await page.evaluate(() =>
          document.cookie.includes("fixture=preserved"),
        ),
        true,
      );
      assert.equal(
        await page.evaluate(
          () =>
            new Promise((done) => {
              const r = indexedDB.open("fastbus-fixture", 1);
              r.onsuccess = () => {
                const q = r.result
                  .transaction("store")
                  .objectStore("store")
                  .get("key");
                q.onsuccess = () => {
                  r.result.close();
                  done(q.result);
                };
              };
            }),
        ),
        "preserved",
      );
    }
    await browser.close();
    browser = undefined;
  }
  console.log("DAYTONA_BROWSER_STORAGE_PASS");
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
  await rm(directory, { recursive: true, force: true });
}
