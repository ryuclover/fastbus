import { test } from "node:test";
import assert from "node:assert/strict";
import type { Client } from "whatsapp-web.js";
import {
  injectWhenReady,
  installNavigationRecovery,
  configureWhatsAppNavigation,
} from "../lib/monitoring/navigation-recovery";
import {
  connectionError,
  connectionMessages,
} from "../lib/monitoring/connection-error";

test("WhatsApp injection waits for the new document and recovers from destroyed contexts", async () => {
  let waits = 0;
  let injections = 0;
  const page = {
    isClosed: () => false,
    waitForFunction: async (
      expression: string,
      options: { timeout: number },
    ) => {
      waits++;
      assert.match(expression, /Debug/);
      assert.ok(options.timeout > 0);
    },
  };
  await injectWhenReady(page, async () => {
    if (++injections === 1)
      throw new Error(
        "Protocol error (Runtime.callFunctionOn): Execution context was destroyed.",
      );
  });
  assert.equal(waits, 2);
  assert.equal(injections, 2);
});
test("genuine injection errors are preserved and navigation retries are bounded", async () => {
  let calls = 0;
  const page = { isClosed: () => false, waitForFunction: async () => {} };
  await assert.rejects(
    injectWhenReady(page, async () => {
      calls++;
      throw new Error("Unexpected module error");
    }),
    /Unexpected module error/,
  );
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(
    injectWhenReady(page, async () => {
      calls++;
      throw new Error("Execution context was destroyed");
    }),
    /Execution context was destroyed/,
  );
  assert.equal(calls, 3);
});
test("simultaneous navigation callbacks share one injection instead of registering twice", async () => {
  let calls = 0;
  let finish!: () => void;
  const wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const client = {
    pupPage: { isClosed: () => false, waitForFunction: async () => {} },
    inject: async () => {
      calls++;
      await wait;
    },
  };
  installNavigationRecovery(client as unknown as Client);
  const first = client.inject();
  const second = client.inject();
  assert.equal(first, second);
  finish();
  await first;
  assert.equal(calls, 1);
});
test("WhatsApp navigation waits for DOM readiness with a deadline, leaving other origins unchanged", async () => {
  const calls: { url: string; options: unknown }[] = [];
  const page = {
    goto: async (url: string, options?: unknown) => {
      calls.push({ url, options });
      return null;
    },
  };
  configureWhatsAppNavigation(
    page as unknown as NonNullable<Client["pupPage"]>,
  );
  await page.goto("https://web.whatsapp.com/", {
    waitUntil: "load",
    timeout: 0,
  });
  assert.deepEqual(calls[0].options, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await page.goto("https://example.com/", { waitUntil: "load", timeout: 100 });
  assert.deepEqual(calls[1].options, { waitUntil: "load", timeout: 100 });
});
test("connection errors expose fixed descriptions without paths, tokens or raw exceptions", () => {
  const code = connectionError(
    new Error(
      "Protocol error: Execution context was destroyed, private-token-value",
    ),
  );
  assert.equal(code, "BROWSER_NAVIGATION");
  assert.ok(!connectionMessages[code].includes("private-token-value"));
  assert.equal(
    connectionError(new Error("net::ERR_NAME_NOT_RESOLVED")),
    "NETWORK_UNAVAILABLE",
  );
});
