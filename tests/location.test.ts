import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveExactSlug } from "../lib/scrapers/location";
import { resolverSlugClickBus } from "../lib/scrapers/clickbus/client";
import { scrapeMobifacil } from "../lib/scrapers/mobifacil/client";
import {
  canonicalCity,
  cityMatches,
  reportedDate,
  routeSlugParts,
} from "../lib/scrapers/location";
import { converterTripsClickBus } from "../lib/scrapers/clickbus/client";
import { matches } from "../lib/monitoring/engine";
import { monitorSchema, today } from "../lib/monitoring/schema";

test("known cities, accented aliases and legacy slugs keep their city and state", () => {
  assert.equal(canonicalCity(" Niterói ", "rj").nome, "Niteroi");
  assert.equal(cityMatches("Nova Cidade", "Cidade", "SP"), false);
  assert.equal(cityMatches("Cidade - RJ", "Cidade", "SP"), false);
  assert.deepEqual(routeSlugParts("curitiba-pr"), {
    city: "curitiba",
    uf: "PR",
  });
  assert.deepEqual(routeSlugParts("sao_paulo-sp-todos"), {
    city: "sao paulo",
    uf: "SP",
  });
  assert.throws(() => routeSlugParts("curitiba"), /LOCATION_NOT_FOUND/);
  assert.equal(
    reportedDate("2030-12-02T01:00:00Z", "2030-12-01", "São Paulo::SP"),
    "2030-12-01",
  );
});

test("an unverified connection cannot use the first leg's quota and a longer city name cannot match", async () => {
  const first = {
    departure: { city: "Cidade", state: "SP" },
    arrival: { city: "Intermediária", state: "MG" },
    tripId: "leg-1",
  };
  const second = {
    departure: { city: "Intermediária", state: "MG" },
    arrival: { city: "Destino", state: "RJ" },
  };
  const raw = [
    { uuid: "connection", parts: [first, second] },
    {
      uuid: "substring",
      price: 9,
      parts: [
        {
          ...first,
          departure: { city: "Nova Cidade", state: "SP" },
          arrival: second.arrival,
        },
      ],
    },
  ];
  let calls = 0;
  for (const benefit of [true, false]) {
    const result = await converterTripsClickBus(
      raw,
      "Cidade",
      "SP",
      "Destino",
      "RJ",
      today(),
      "https://www.clickbus.com.br/",
      benefit,
      async () => {
        calls++;
        return null;
      },
    );
    assert.deepEqual(result.resultados, []);
    assert.equal(result.coverage.unsupportedConnections, 1);
  }
  assert.equal(calls, 0);
});

test("selected terminal requires confirmed exact boarding and alighting names", () => {
  const config = monitorSchema.parse({
    origin: "Sao Paulo::SP",
    destination: "Rio de Janeiro::RJ",
    startDate: today(),
    endDate: today(),
    maxPrice: 100,
    intervalMinutes: 1440,
    benefit: "any",
    providers: ["ClickBus"],
    originTerminal: "Tietê",
    destinationTerminal: "Novo Rio",
  });
  const item = {
    empresa: "Via",
    valorNumerico: 10,
    originStop: { city: "São Paulo", id: "1", terminal: "Tiete" },
    destinationStop: { city: "Rio de Janeiro", id: "2", terminal: "Novo Rio" },
  };
  assert.ok(matches(item, config));
  assert.equal(matches({ ...item, destinationStop: undefined }, config), false);
  assert.equal(
    matches(
      { ...item, originStop: { ...item.originStop, terminal: "Tietê Norte" } },
      config,
    ),
    false,
  );
  assert.ok(
    matches(
      { ...item, originStop: undefined },
      { ...config, originTerminal: undefined },
    ),
  );
});

test("empty list and network errors stop ClickBus before inventory", async () => {
  const original = globalThis.fetch;
  try {
    for (const value of [[], null]) {
      let calls = 0;
      globalThis.fetch = async () => {
        calls++;
        if (value === null) throw new Error("NETWORK_UNAVAILABLE");
        return Response.json(value);
      };
      await assert.rejects(
        resolverSlugClickBus("Teste", "RJ"),
        value === null ? /NETWORK_UNAVAILABLE/ : /LOCATION_NOT_FOUND/,
      );
      assert.equal(calls, 1);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("locality resolution rejects homonyms, substrings and ambiguous terminal scope", () => {
  assert.equal(
    resolveExactSlug(
      [{ slug: "cidade-rj" }, { slug: "cidade-sp" }],
      "cidade-sp",
    ),
    "cidade-sp",
  );
  assert.equal(
    resolveExactSlug([{ slug: "cidade-sp-todos" }], "cidade-sp"),
    "cidade-sp-todos",
  );
  assert.throws(
    () => resolveExactSlug([{ slug: "nova-cidade-sp" }], "cidade-sp"),
    /LOCATION_NOT_FOUND/,
  );
  assert.throws(
    () =>
      resolveExactSlug(
        [{ slug: "cidade-sp" }, { slug: "cidade-sp-todos" }],
        "cidade-sp",
      ),
    /LOCATION_AMBIGUOUS/,
  );
  assert.throws(
    () => resolveExactSlug(null, "cidade-sp"),
    /PROVIDER_INVALID_RESPONSE/,
  );
});
test("provider resolvers do not query an unrelated suggested locality", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls++;
      return Response.json([
        { slug: "outra-cidade-sp", state: { code: "SP" } },
      ]);
    };
    await assert.rejects(
      resolverSlugClickBus("Cidade Teste", "SP"),
      /LOCATION_NOT_FOUND/,
    );
    assert.equal(calls, 1);
    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return Response.json({
        origins: [{ slug: "outra-cidade-sp", uf: "SP" }],
      });
    };
    const result = await scrapeMobifacil(
      "Cidade Teste",
      "SP",
      "Rio de Janeiro",
      "RJ",
      "2026-12-01",
    );
    assert.equal(result.error, "LOCATION_NOT_FOUND");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
