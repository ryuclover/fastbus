import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chromium } from "playwright";
import { prepareExtensionControls } from "../lib/scrapers/clickbus/extension-controls";

const executablePath =
  process.env.WHATSAPP_CHROME_PATH ||
  (process.platform === "win32"
    ? "C:/Program Files/Google/Chrome/Application/chrome.exe"
    : chromium.executablePath());
test(
  "extension controls handle shadow DOM, padded text, hidden consent and an onboarding overlay",
  { skip: !existsSync(executablePath) },
  async () => {
    const browser = await chromium.launch({ executablePath, headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(
        '<button hidden>Accept</button><div id="host"></div>',
      );
      await page.evaluate(() => {
        const shadow = document
          .querySelector("#host")!
          .attachShadow({ mode: "open" });
        shadow.innerHTML = `<button id="start">\n      Start VPN\n    </button><first-start-tips-start-vpn style="position:fixed;inset:0;background:#aaa"><button class="Close">×</button></first-start-tips-start-vpn>`;
        shadow
          .querySelector(".Close")!
          .addEventListener("click", () =>
            shadow.querySelector("first-start-tips-start-vpn")!.remove(),
          );
        shadow
          .querySelector("#start")!
          .addEventListener(
            "click",
            () => (document.body.dataset.started = "true"),
          );
      });
      const controls = await prepareExtensionControls(page);
      await controls.ready.waitFor({ state: "visible", timeout: 5000 });
      assert.equal(await controls.accept.isVisible(), false);
      await controls.start.click({ timeout: 5000 });
      assert.equal(
        await page.locator("body").getAttribute("data-started"),
        "true",
      );
      await page.setContent(
        '<div class="ChangeButton">\n  Change\n</div><button hidden>Start VPN</button>',
      );
      const restored = await prepareExtensionControls(page);
      await restored.ready.waitFor({ state: "visible", timeout: 5000 });
      assert.equal(await restored.change.isVisible(), true);
    } finally {
      await browser.close();
    }
  },
);
