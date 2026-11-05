import { test } from "node:test";
import assert from "node:assert/strict";
import {
  adaptiveDelay,
  challengeResponse,
  isChallengeHtml,
  retryAfterMs,
} from "../lib/monitoring/response-policy";
import {
  withRequestBudget,
  monitoredFetch,
} from "../lib/monitoring/request-budget";
import { freeBrowserEgress } from "../lib/monitoring/free-egress";
import { LookupCache } from "../lib/monitoring/lookup-cache";
import { publicBrowserEnvironment } from "../lib/monitoring/browser-environment";
import { fetchGuanabaraDirect } from "../lib/scrapers/guanabara/client";
import { scrapeMobifacil } from "../lib/scrapers/mobifacil/client";

test("Retry-After handles seconds, HTTP dates, server clock skew and malformed values", () => {
  const now = Date.parse("2026-11-04T12:00:00Z");
  assert.equal(retryAfterMs(" 120 ", null, now), 120000);
  assert.equal(
    retryAfterMs(
      "Wed, 04 Nov 2026 13:00:00 GMT",
      "Wed, 04 Nov 2026 12:30:00 GMT",
      now,
    ),
    1800000,
  );
  for (const value of [
    "bad",
    "-1",
    "9".repeat(400),
    "Tue, 03 Nov 2026 12:00:00 GMT",
  ])
    assert.equal(retryAfterMs(value, null, now), 0);
});

test("adaptive waiting slows down with latency and errors never shorten the previous delay", () => {
  assert.equal(adaptiveDelay(4000, 9000, true), 9000);
  assert.equal(adaptiveDelay(9000, 10, false), 9000);
  assert.equal(adaptiveDelay(9000, 10, true), 6500);
  assert.equal(adaptiveDelay(4000, 60000, true), 15000);
});

test("the extension browser receives only OS/display configuration, never app or WhatsApp credentials", () => {
  assert.deepEqual(
    publicBrowserEnvironment({
      PATH: "/bin",
      DISPLAY: ":99",
      DBUS_SESSION_BUS_ADDRESS: "fixture-bus",
      TURSO_AUTH_TOKEN: "fixture-secret",
      FASTBUS_DATA_KEY: "fixture-secret",
      DAYTONA_API_KEY: "fixture-secret",
      VERCEL_OIDC_TOKEN: "fixture-secret",
      HTTP_PROXY: "fixture-secret",
    }),
    { PATH: "/bin", DISPLAY: ":99", DBUS_SESSION_BUS_ADDRESS: "fixture-bus" },
  );
});

test("free VPN location changes only at six-hour boundaries; it remains stable for all requests in a session", () => {
  const period = 6 * 3600000;
  assert.deepEqual(
    [0, 1, 2, 3, 4].map((n) => freeBrowserEgress(n * period, true).code),
    ["US", "NL", "GB", "SG", "US"],
  );
  assert.equal(
    freeBrowserEgress(period + 1, true).code,
    freeBrowserEgress(2 * period - 1, true).code,
  );
  assert.equal(freeBrowserEgress(2 * period, false).code, "US");
});

test("metadata cache is bounded, expires old lookups and evicts the least recently used", (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1000000 });
  const cache = new LookupCache<string>(2, 60000);
  cache.set("one", "a");
  cache.set("two", "b");
  assert.equal(cache.get("one"), "a");
  cache.set("three", "c");
  assert.equal(cache.has("two"), false);
  t.mock.timers.tick(60001);
  assert.equal(cache.get("one"), undefined);
});

test("challenge detection preserves normal pages and JSON that mention a CAPTCHA", async () => {
  assert.equal(
    isChallengeHtml(
      '<main><div class="g-recaptcha">Reserve sua viagem</div></main>',
    ),
    false,
  );
  assert.equal(isChallengeHtml("<title>Just a moment...</title>"), true);
  const response = new Response("<main>Passagens</main>", {
    headers: { "content-type": "text/html" },
  });
  assert.equal(await challengeResponse(response), false);
  assert.equal(await response.text(), "<main>Passagens</main>");
  assert.equal(
    await challengeResponse(
      Response.json({ html: "<title>Access denied</title>" }),
    ),
    false,
  );
  const big = new Response("a".repeat(32768) + "<title>Access denied</title>");
  assert.equal(await challengeResponse(big), false); // bounded inspection, not an unbounded copy
  assert.equal((await big.text()).length > 32768, true);
});

test("a Cloudflare challenge with HTTP 200 stops the whole query without changing exit or retrying", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("challenge", {
      headers: { "cf-mitigated": "challenge", "retry-after": "3600" },
    });
  };
  try {
    const { budget } = await withRequestBudget(async () => {
      await assert.rejects(
        monitoredFetch("https://example.com"),
        /PROVIDER_BLOCKED/,
      );
      await assert.rejects(
        monitoredFetch("https://example.com/other"),
        /PROVIDER_BLOCKED/,
      );
    });
    assert.equal(calls, 1);
    assert.ok(budget.blockedUntil >= Date.now() + 3590000);
  } finally {
    globalThis.fetch = original;
  }
});

test("HTML challenges and server outages cannot trigger fallback requests or appear as empty availability", async () => {
  const original = globalThis.fetch;
  try {
    for (const response of [
      () => new Response("<title>Access denied</title>"),
      () => new Response("outage", { status: 502 }),
    ]) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return response();
      };
      const { budget, result } = await withRequestBudget(() =>
        fetchGuanabaraDirect(
          "Rio de Janeiro",
          "RJ",
          "Sao Paulo",
          "SP",
          "2026-11-20",
        ),
      );
      assert.equal(calls, 1);
      assert.equal(result.error, "PROVIDER_BLOCKED");
      assert.ok(budget.blockedUntil > Date.now());
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("redirects are individually counted and paced; cookies never cross origins", async () => {
  const original = globalThis.fetch;
  let calls = 0,
    secondAt = 0,
    firstAt = 0;
  globalThis.fetch = async (_input, options) => {
    assert.equal(options?.redirect, "manual");
    if (++calls === 1) {
      firstAt = Date.now();
      return new Response(null, {
        status: 301,
        headers: { location: "https://www.example.com/final" },
      });
    }
    secondAt = Date.now();
    assert.equal(new Headers(options?.headers).has("cookie"), false);
    assert.equal(new Headers(options?.headers).has("authorization"), false);
    return Response.json({ ok: true });
  };
  try {
    const { budget, result } = await withRequestBudget(() =>
      monitoredFetch("https://example.com", {
        headers: { cookie: "fixture-only", authorization: "fixture-only" },
      }),
    );
    assert.deepEqual(await result.json(), { ok: true });
    assert.equal(budget.count, 2);
    assert.ok(secondAt - firstAt >= 3900);
  } finally {
    globalThis.fetch = original;
  }
});

test("external redirects, HTTPS downgrades and POST replay are refused without another request", async () => {
  const original = globalThis.fetch;
  try {
    for (const [location, options, code] of [
      ["https://other.example", {}, "PROVIDER_UNTRUSTED_REDIRECT"],
      ["http://example.com", {}, "PROVIDER_UNTRUSTED_REDIRECT"],
      [
        "/replay",
        { method: "POST", body: "fixture" },
        "PROVIDER_REDIRECT_REPLAY_REFUSED",
      ],
    ] as const) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        return new Response(null, { status: 307, headers: { location } });
      };
      await withRequestBudget(async () => {
        await assert.rejects(
          monitoredFetch("https://example.com", options),
          new RegExp(code),
        );
      });
      assert.equal(calls, 1);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("Guanabara checks unique seat maps sequentially and caps batches instead of enqueuing fifteen requests", async () => {
  const original = globalThis.fetch;
  let active = 0,
    maxActive = 0;
  const ids: number[] = [];
  globalThis.fetch = async (input, options) => {
    if (!String(input).includes("/seats/maps/"))
      return Response.json({
        trips: Array.from({ length: 20 }, (_, n) => ({
          trip_id: Math.floor(n / 2) + 1,
          total: 10,
          fare: 0,
          boarding_fee: 10,
          class_of_service: "Convencional",
        })),
      });
    maxActive = Math.max(maxActive, ++active);
    ids.push(JSON.parse(String(options?.body)).id_daily_schedule_route);
    await Promise.resolve();
    active--;
    return Response.json({
      passengerTypeAvailability: [
        { name: "100%", available_seats: 2 },
        { name: "50%", available_seats: 0 },
      ],
    });
  };
  try {
    await fetchGuanabaraDirect(
      "Rio de Janeiro",
      "RJ",
      "Sao Paulo",
      "SP",
      "2026-11-21",
      true,
    );
    assert.equal(ids.length, 6);
    assert.equal(new Set(ids).size, 6);
    assert.equal(maxActive, 1);
    const first = [...ids];
    ids.length = 0;
    await fetchGuanabaraDirect(
      "Rio de Janeiro",
      "RJ",
      "Sao Paulo",
      "SP",
      "2026-11-21",
      true,
    );
    assert.notEqual(ids[0], first[0]);
  } finally {
    globalThis.fetch = original;
  }
});

test("Mobifacil uses known city slugs without redundant discovery requests", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return new Response("<main>Nenhum horário</main>");
  };
  try {
    await scrapeMobifacil("Sao Paulo", "SP", "Curitiba", "PR", "2026-11-22");
    assert.equal(urls.length, 1);
    assert.match(urls[0], /passagem-de-onibus\/sao-paulo-sp\/curitiba-pr/);
  } finally {
    globalThis.fetch = original;
  }
});
