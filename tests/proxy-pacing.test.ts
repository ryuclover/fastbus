import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import {
  parseProxyUrls,
  ProviderProxyPool,
  closeProviderProxies,
} from "../lib/monitoring/proxy";
import {
  requestSpacing,
  providerSpacing,
  monitorSpacing,
  providerBackoff,
} from "../lib/monitoring/pacing";
import {
  monitoredFetch,
  withRequestBudget,
} from "../lib/monitoring/request-budget";

test("variable pacing always preserves minimum intervals", () => {
  const samples = new Set<number>();
  for (let i = 0; i < 100; i++) {
    const spacing = requestSpacing();
    samples.add(spacing);
    assert.ok(spacing >= 4000 && spacing <= 8000);
    const provider = providerSpacing();
    assert.ok(provider >= 300000 && provider <= 420000);
    const monitor = monitorSpacing(30);
    assert.ok(monitor >= 1800000 && monitor <= 1980000);
  }
  assert.ok(samples.size > 1);
});

test("provider backoff doubles from fifteen minutes and stays capped at one day", () => {
  assert.deepEqual(
    [1, 2, 3, 7, 8, 100].map(providerBackoff),
    [15, 30, 60, 960, 1440, 1440].map((minutes) => minutes * 60000),
  );
});

test("proxy configuration rejects malformed lists without revealing secrets", () => {
  assert.deepEqual(parseProxyUrls(), []);
  assert.equal(
    parseProxyUrls('["https://user:secret@proxy.example:443"]').length,
    1,
  );
  for (const raw of [
    '["socks5://user:secret@proxy.example"]',
    '["https://proxy.example/path"]',
    '["http://u:%ZZ@proxy.example"]',
    "{}",
    "secret",
  ]) {
    assert.throws(
      () => parseProxyUrls(raw),
      (error: Error) =>
        !error.message.includes("secret") && /inválido/.test(error.message),
    );
  }
});

test("proxy pool rotates queries and reuses the selected exits", async () => {
  const pool = new ProviderProxyPool(
    parseProxyUrls('["http://127.0.0.1:10001", "http://127.0.0.1:10002"]'),
  );
  try {
    const first = pool.next();
    assert.notEqual(pool.next(), first);
    assert.equal(pool.next(), first);
  } finally {
    await pool.close();
  }
});

test("short network timeouts start after pacing rather than expiring while queued", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_input, options) => {
    calls++;
    assert.equal(options?.signal?.aborted, false);
    return new Response("ok");
  };
  try {
    await withRequestBudget(async () => {
      await monitoredFetch("https://example.com", { timeoutMs: 20 });
      await monitoredFetch("https://example.com", { timeoutMs: 20 });
    });
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = original;
    await closeProviderProxies();
  }
});

test("real CONNECT proxy is used only in the monitoring context; 429 makes no second request", async () => {
  let targetCalls = 0;
  let tunnels = 0;
  let auth = "";
  const sockets = new Set<import("node:stream").Duplex>();
  const target = createServer((request, response) => {
    assert.equal(request.headers["proxy-authorization"], undefined);
    targetCalls++;
    if (targetCalls > 1) {
      response.writeHead(429, { "retry-after": "3600" });
      response.end("blocked");
    } else response.end("direct");
  });
  const proxy = createServer();
  proxy.on("connect", (request, socket, head) => {
    tunnels++;
    auth = String(request.headers["proxy-authorization"]);
    const upstream = connect(
      (target.address() as import("node:net").AddressInfo).port,
      "127.0.0.1",
      () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream).pipe(socket);
      },
    );
    sockets.add(socket);
    sockets.add(upstream);
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  target.listen(0, "127.0.0.1");
  proxy.listen(0, "127.0.0.1");
  await Promise.all([once(target, "listening"), once(proxy, "listening")]);
  const old = process.env.FASTBUS_PROVIDER_PROXY_URLS;
  const url = `http://127.0.0.1:${(target.address() as import("node:net").AddressInfo).port}`;
  process.env.FASTBUS_PROVIDER_PROXY_URLS = JSON.stringify([
    `http://test:password@127.0.0.1:${(proxy.address() as import("node:net").AddressInfo).port}`,
  ]);
  try {
    assert.equal(await (await monitoredFetch(url)).text(), "direct");
    assert.equal(tunnels, 0);
    const { budget } = await withRequestBudget(async () => {
      await assert.rejects(monitoredFetch(url), /PROVIDER_BLOCKED/);
      await assert.rejects(monitoredFetch(url), /PROVIDER_BLOCKED/);
    });
    assert.equal(tunnels, 1);
    assert.equal(
      auth,
      `Basic ${Buffer.from("test:password").toString("base64")}`,
    );
    assert.equal(targetCalls, 2);
    assert.ok(budget.blockedUntil > Date.now() + 3500000);
  } finally {
    if (old === undefined) delete process.env.FASTBUS_PROVIDER_PROXY_URLS;
    else process.env.FASTBUS_PROVIDER_PROXY_URLS = old;
    await closeProviderProxies();
    for (const socket of sockets) socket.destroy();
    target.closeAllConnections();
    proxy.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => target.close(() => resolve())),
      new Promise<void>((resolve) => proxy.close(() => resolve())),
    ]);
  }
});
