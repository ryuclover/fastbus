import { test } from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { ClickBusSession } from "../lib/scrapers/clickbus/client";
import {
  parseClickBusQuotas,
  parseClickBusQuotasHtml,
} from "../lib/scrapers/clickbus/benefits";
import { withRequestBudget } from "../lib/monitoring/request-budget";

const quota = {
  youngIdFullPrice: { amount: 2, price: 0 },
  youngIdPartialPrice: { amount: 1, price: 55.5 },
};
function fixtureTrip(discounts: unknown, id = "yes", online = true) {
  const raw = discounts as Record<string, unknown>;
  const typed = Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [
      key,
      key.startsWith("youngId")
        ? {
            type: "YOUNG_ID",
            young: true,
            percentage: key === "youngIdFullPrice" ? 100 : 50,
            ...(value as object),
          }
        : value,
    ]),
  );
  return { uuid: id, travelCompany: { hasGratuity: online }, discounts: typed };
}
function page(discounts: unknown, id = "yes", online = true) {
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { trips: [fixtureTrip(discounts, id, online)] } } })}</script>`;
}
function rsc(discounts: unknown, id = "yes") {
  const data = `1:${JSON.stringify({ trips: [{ ...fixtureTrip(discounts, id), label: 'Terminal "Central" {A}' }] })}\n`;
  return `<script>self.__next_f.push(${JSON.stringify([1, data])})</script>`;
}
test("ClickBus reads explicit youth quotas from both Next JSON and escaped RSC without corrupting strings", () => {
  assert.deepEqual(parseClickBusQuotasHtml(page(quota)), {
    vagas100: 2,
    vagas50: 1,
    preco100: 0,
    preco50: 55.5,
  });
  assert.deepEqual(
    parseClickBusQuotasHtml(rsc(quota)),
    parseClickBusQuotas(quota),
  );
});
test("ClickBus rejects conflicting snapshots, truncated JSON and unrelated senior discounts", () => {
  assert.equal(
    parseClickBusQuotasHtml(
      page(quota) + page({ youngIdFullPrice: { amount: 0, price: 0 } }),
    ),
    null,
  );
  assert.equal(
    parseClickBusQuotasHtml('<script>{"discounts":{"youngIdFullPrice":'),
    null,
  );
  assert.equal(
    parseClickBusQuotasHtml(page({ seniorFullPrice: { amount: 2, price: 0 } })),
    null,
  );
  assert.equal(
    parseClickBusQuotas({ youngIdFullPrice: { amount: -1, price: 0 } }),
    null,
  );
  assert.equal(
    parseClickBusQuotas({ youngIdFullPrice: { amount: 1.5, price: 0 } }),
    null,
  );
});
test("ClickBus absent or invalid prices never become a free ticket", () => {
  for (const value of [
    undefined,
    null,
    "",
    true,
    -1,
    "NaN",
    "Infinity",
    "1.234",
  ]) {
    assert.equal(
      parseClickBusQuotas({ youngIdFullPrice: { amount: 2, price: value } })
        ?.preco100,
      undefined,
    );
  }
  assert.equal(
    parseClickBusQuotas({ youngIdFullPrice: { amount: "2", price: "10,13" } })
      ?.preco100,
    10.13,
  );
});

function trip(id: string, date: string) {
  return {
    uuid: id,
    price: 100,
    options: { hasGratuityCheckout: true, isGratuityTrip: true },
    parts: [
      {
        tripId: id,
        departure: { city: "Rio de Janeiro", state: "RJ", date, time: "12:00" },
        arrival: { city: "Sao Paulo", state: "SP", date, time: "19:00" },
        travelCompany: { name: "Viação Teste" },
        serviceClass: { name: "Convencional" },
      },
    ],
  };
}
function search(date: string) {
  return new ClickBusSession().buscarData(
    "Rio de Janeiro",
    "RJ",
    "Sao Paulo",
    "SP",
    date,
    true,
  );
}
test("ClickBus adapter confirms both quota types, rejects exhausted/unknown/negative fares and checks serially", async () => {
  const original = globalThis.fetch;
  const date = "2026-11-19";
  let inflight = 0;
  let maximum = 0;
  globalThis.fetch = async (input) => {
    inflight++;
    maximum = Math.max(maximum, inflight);
    await setImmediate();
    inflight--;
    const url = new URL(String(input));
    if (url.pathname.endsWith("/trips"))
      return Response.json({
        trips: ["yes", "exhausted", "unknown", "negative"].map((id) =>
          trip(id, date),
        ),
      });
    const id = url.searchParams.get("tripId");
    return new Response(
      rsc(
        id === "yes"
          ? quota
          : id === "exhausted"
            ? { youngIdFullPrice: { amount: 0, price: 0 } }
            : id === "unknown"
              ? { youngIdFullPrice: { amount: 2 } }
              : { youngIdPartialPrice: { amount: 1, price: -10 } },
        id!,
      ),
    );
  };
  try {
    const result = await search(date);
    assert.equal(maximum, 1);
    assert.equal(result.error, undefined);
    assert.equal(result.resultados.length, 2);
    assert.ok(
      result.resultados.every(
        (item) =>
          new URL(item.linkCompra!).searchParams.get("tripId") === "yes",
      ),
    );
    assert.deepEqual(
      result.resultados.map((item) => [
        item.tipoGratuidade,
        item.valorNumerico,
        item.vagasIdJovem,
      ]),
      [
        ["id_jovem_100", 0, 2],
        ["id_jovem_50", 55.5, 1],
      ],
    );
  } finally {
    globalThis.fetch = original;
  }
});
test("ClickBus rotates bounded batches instead of permanently overlooking the seventh candidate", async () => {
  const original = globalThis.fetch;
  const date = "2026-11-20";
  const checked: string[] = [];
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/trips"))
      return Response.json({
        trips: Array.from({ length: 7 }, (_, i) => trip(String(i), date)),
      });
    const id = url.searchParams.get("tripId")!;
    checked.push(id);
    return new Response(
      page(
        id === "6" ? quota : { youngIdFullPrice: { amount: 0, price: 0 } },
        id,
      ),
    );
  };
  try {
    const first = await search(date);
    assert.equal(first.error, "ID_JOVEM_UNCONFIRMED");
    assert.deepEqual(checked, ["0", "1", "2", "3", "4", "5"]);
    const second = await search(date);
    assert.equal(checked[6], "6");
    assert.equal(second.resultados.length, 2);
    assert.equal(checked.length, 12);
  } finally {
    globalThis.fetch = original;
  }
});
test("ClickBus 403 is an error rather than evidence of no youth seats and stops after one request", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return Response.json({ error: "Forbidden resource" }, { status: 403 });
  };
  try {
    const { result, budget } = await withRequestBudget(() =>
      search("2026-11-21"),
    );
    assert.equal(result.error, "PROVIDER_BLOCKED");
    assert.equal(result.disponivel, false);
    assert.equal(calls, 1);
    assert.ok(budget.blockedUntil > Date.now());
  } finally {
    globalThis.fetch = original;
  }
});
test("ClickBus reserves the quota budget after resolving both cities and preserves confirmed offers at the limit", async () => {
  const original = globalThis.fetch;
  const originalNow = Date.now;
  let now = originalNow();
  let calls = 0;
  Date.now = () => now;
  globalThis.fetch = async (input) => {
    calls++;
    now += 10000;
    const url = new URL(String(input));
    if (url.pathname.endsWith("/places"))
      return Response.json([
        {
          slug:
            url.searchParams.get("name") === "Niteroi"
              ? "niteroi-rj"
              : "taubate-sp",
          state: {
            code: url.searchParams.get("name") === "Niteroi" ? "RJ" : "SP",
          },
        },
      ]);
    if (url.pathname.endsWith("/trips"))
      return Response.json({
        trips: Array.from({ length: 8 }, (_, i) => {
          const value = trip(String(i), "2026-12-22");
          value.parts[0].departure.city = "Niteroi";
          value.parts[0].arrival.city = "Taubate";
          return value;
        }),
      });
    return new Response(page(quota, url.searchParams.get("tripId")!));
  };
  try {
    const { result, budget } = await withRequestBudget(() =>
      new ClickBusSession().buscarData(
        "Niteroi",
        "RJ",
        "Taubate",
        "SP",
        "2026-12-22",
        true,
      ),
    );
    assert.equal(calls, 8);
    assert.equal(budget.count, 8);
    assert.equal(budget.limited, false);
    assert.equal(result.resultados.length, 10);
    assert.equal(result.error, undefined);
  } finally {
    Date.now = originalNow;
    globalThis.fetch = original;
  }
});

test("ClickBus stops quota checks when an HTML challenge arrives with HTTP 200", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return calls === 1
      ? Response.json({
          trips: [trip("one", "2026-11-23"), trip("two", "2026-11-23")],
        })
      : new Response("<html><title>Just a moment...</title></html>");
  };
  try {
    const { result, budget } = await withRequestBudget(() =>
      search("2026-11-23"),
    );
    assert.equal(result.error, "PROVIDER_BLOCKED");
    assert.equal(calls, 2);
    assert.ok(budget.blockedUntil > Date.now());
  } finally {
    globalThis.fetch = original;
  }
});

test("ClickBus unexpected payload is an error, while a confirmed empty trip array is empty availability", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ message: "unexpected" });
    assert.equal((await search("2026-11-22")).error, "CLICKBUS_QUERY_FAILED");
    globalThis.fetch = async () => Response.json({ trips: [] });
    assert.equal((await search("2026-11-22")).error, undefined);
    globalThis.fetch = async () => new Response("not found", { status: 404 });
    assert.equal((await search("2026-11-22")).error, "CLICKBUS_HTTP_404");
  } finally {
    globalThis.fetch = original;
  }
});
