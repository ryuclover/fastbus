import { test } from "node:test";
import assert from "node:assert/strict";
import {
  processarTripsEmbarca,
  scrapeEmbarca,
} from "../lib/scrapers/embarca/client";
import { withRequestBudget } from "../lib/monitoring/request-budget";
import { fetchGuanabaraDirect } from "../lib/scrapers/guanabara/client";
import { scrapeAguiaBranca } from "../lib/scrapers/aguiabranca/client";
import { scrapeGontijo } from "../lib/scrapers/gontijo/client";
import { PROVIDER_CAPABILITIES } from "../types/providers";
import { matches } from "../lib/monitoring/engine";
import { today, type MonitorConfig } from "../lib/monitoring/schema";

const config: MonitorConfig = {
  origin: "Rio de Janeiro::RJ",
  destination: "Sao Paulo::SP",
  startDate: today(),
  endDate: today(),
  maxPrice: 200,
  intervalMinutes: 60,
  benefit: "id100",
  providers: ["Embarca"],
};
test("Embarca reports invalid payloads as failures and stops on a monitored block instead of reporting an empty success", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ unexpected: true });
    const invalid = await scrapeEmbarca(
      "Rio de Janeiro",
      "RJ",
      "Sao Paulo",
      "SP",
      today(),
    );
    assert.equal(invalid.error, "PROVIDER_INVALID_RESPONSE");
    let calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("blocked", { status: 403 });
    };
    const blocked = await withRequestBudget(() =>
      scrapeEmbarca("Rio de Janeiro", "RJ", "Sao Paulo", "SP", today()),
    );
    assert.equal(blocked.result.error, "PROVIDER_BLOCKED");
    assert.equal(calls, 1);
    assert.ok(blocked.budget.blockedUntil > Date.now());
    globalThis.fetch = async () => {
      calls++;
      return Response.json([]);
    };
    calls = 0;
    const empty = await scrapeEmbarca(
      "Rio de Janeiro",
      "RJ",
      "Sao Paulo",
      "SP",
      today(),
    );
    assert.equal(empty.error, undefined);
    assert.equal(empty.resultados.length, 0);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
function parse(trips: unknown[], benefit: boolean) {
  return processarTripsEmbarca(
    trips,
    "Rio de Janeiro",
    "RJ",
    "Sao Paulo",
    "SP",
    today(),
    "https://embarca.ai",
    benefit,
  );
}
test("Embarca does not turn eligibility strings or absent commercial prices into free tickets", () => {
  assert.deepEqual(
    parse(
      [
        {
          seat_class: "Convencional",
          disable_gratuity: false,
          gratuity_types: ["free", "gratuity"],
        },
      ],
      true,
    ),
    [],
  );
  assert.deepEqual(parse([{ seat_class: "Convencional" }], false), []);
  const noPrice = parse(
    [
      {
        seat_class: "Convencional",
        gratuity_types: [{ category_id: 5, available: 2 }],
      },
    ],
    true,
  );
  assert.ok(noPrice.every((item) => !matches(item, config)));
  const real = parse(
    [
      {
        seat_class: "Convencional",
        gratuity_types: [
          { category_id: 5, available: 2, total_price: "10.13" },
        ],
      },
    ],
    true,
  );
  assert.equal(real.length, 1);
  assert.ok(matches(real[0], config));
  assert.equal(real[0].valorNumerico, 10.13);
});
test("Guanabara requires a real price and confirmed seat quota instead of guessed defaults", async () => {
  const original = globalThis.fetch;
  let trips: unknown[] = [{ trip_id: 1, routes: [{ available_seats: 2 }] }];
  globalThis.fetch = async (input) =>
    String(input).includes("/seats/maps/")
      ? Response.json({
          passengerTypeAvailability: [
            { name: "100%", available_seats: 0 },
            { name: "50%", available_seats: 2 },
          ],
        })
      : Response.json({ trips });
  try {
    const noPrice = await fetchGuanabaraDirect(
      "Rio de Janeiro",
      "RJ",
      "Sao Paulo",
      "SP",
      today(),
      false,
    );
    assert.equal(noPrice.resultados.length, 0);
    trips = [
      {
        trip_id: 1,
        fare: 0,
        total: 10.13,
        boarding_fee: 10.13,
        routes: [{ available_seats: 2, class_of_service_name: "Convencional" }],
      },
    ];
    const noFreeQuota = await fetchGuanabaraDirect(
      "Rio de Janeiro",
      "RJ",
      "Sao Paulo",
      "SP",
      today(),
      true,
    );
    assert.equal(noFreeQuota.resultados.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});
test("Guanabara positive fare without fee fields cannot become a free fare", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) =>
    String(input).includes("/seats/maps/")
      ? Response.json({
          passengerTypeAvailability: [
            { name: "100%", available_seats: 2 },
            { name: "50%", available_seats: 0 },
          ],
        })
      : Response.json({
          trips: [
            {
              trip_id: 1,
              fare: 100,
              total: 100,
              class_of_service: "Convencional",
              routes: [{ available_seats: 2 }],
            },
          ],
        });
  try {
    const result = await fetchGuanabaraDirect(
      "Rio de Janeiro",
      "RJ",
      "Sao Paulo",
      "SP",
      today(),
      true,
    );
    assert.equal(result.resultados.length, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("Guanabara binds the youth price to its route, class and seat quota, preserving partial results", async () => {
  const original = globalThis.fetch;
  const base = {
    class_of_service: "Convencional",
    fare: 50,
    total: 55,
    original_price: 100,
    passenger_classification_id: 13,
  };
  const trips = [
    {
      ...base,
      trip_id: 11,
      origin: { date_time: "2026-12-01T12:00:00-03:00" },
    },
    { ...base, trip_id: 12, fare: 49 },
    { ...base, trip_id: 13, passenger_classification_id: 2 },
    { ...base, trip_id: 14, fare: 0, total: 5, boarding_fee: 5 },
    { ...base, trip_id: 15, class_of_service: null },
    { ...base, trip_id: 16, fare: "50 reais" },
  ];
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes("/seats/maps/")) return Response.json({ trips });
    const route = JSON.parse(String(init?.body)).id_daily_schedule_route;
    return Response.json({
      passengerTypeAvailability: [
        { name: "ID Jovem 100%", available_seats: route === 14 ? 1 : 0 },
        { name: "ID Jovem 50%", available_seats: 2 },
        { name: "Idoso 100%", available_seats: 4 },
      ],
    });
  };
  try {
    const result = await fetchGuanabaraDirect(
      "Rio",
      "RJ",
      "São Paulo",
      "SP",
      today(),
      true,
    );
    assert.deepEqual(
      result.resultados.map((i) => [
        i.providerTripId,
        i.tipoGratuidade,
        i.valorNumerico,
      ]),
      [
        ["11", "id_jovem_50", 55],
        ["14", "id_jovem_100", 5],
      ],
    );
    assert.deepEqual(result.coverage, {
      candidates: 6,
      checked: 6,
      unconfirmed: 4,
      partial: true,
    });
    const first = result.resultados[0];
    const departure = Date.UTC(2026, 11, 1, 15);
    assert.equal(first.departureAt, departure);
    assert.equal(
      matches(first, { ...config, benefit: "any" }, departure - 1),
      true,
    );
    assert.equal(
      matches(first, { ...config, benefit: "any" }, departure),
      false,
    );
    assert.equal(result.resultados[1].departureAt, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("Águia Branca does not infer free seats from selecting an ID Jovem filter", async () => {
  const result = await scrapeAguiaBranca(
    "Rio de Janeiro",
    "RJ",
    "Sao Paulo",
    "SP",
    today(),
    true,
  );
  assert.equal(result.disponivel, false);
  assert.equal(result.error, "ID_JOVEM_UNCONFIRMED");
});

test("Águia Branca keeps commercial card prices, classes and schedules", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(`<main>
    <div class="y_fareResultTravelOption" data-price="109.90">
      <span class="saida">18/11/2026 08:30</span>
      <span class="chegada">18/11/2026 14:30</span>
      <span class="classe">Executivo</span>
      <span class="assentos-livres">8</span>
    </div>
    <div class="y_fareResultTravelOption">R$ 120,50</div>
  </main>`);
  try {
    const result = await scrapeAguiaBranca(
      "Rio de Janeiro",
      "RJ",
      "Sao Paulo",
      "SP",
      today(),
    );
    assert.equal(result.disponivel, true);
    assert.equal(result.vagasIdJovem, 0);
    assert.equal(result.resultados.length, 2);
    assert.deepEqual(
      result.resultados.map((item) => item.valorNumerico),
      [109.9, 120.5],
    );
    assert.equal(result.resultados[0].horario, "08:30");
    assert.equal(result.resultados[0].chegada, "14:30");
    assert.equal(result.resultados[0].duracao, "6h 00min");
    assert.equal(result.resultados[0].classe, "Executivo");
    assert.equal(result.resultados[0].poltronasLivres, 8);
    assert.ok(
      result.resultados.every(
        (item) => item.tipoGratuidade === "nenhuma" && item.vagasIdJovem === 0,
      ),
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("Gontijo provides manual guidance without claiming confirmed inventory or line operation", async () => {
  const result = await scrapeGontijo(
    "Belo Horizonte",
    "MG",
    "Sao Paulo",
    "SP",
    today(),
    true,
  );
  assert.equal(result.provedor, "Gontijo");
  assert.equal(result.disponivel, false);
  assert.equal(result.vagasIdJovem, 0);
  assert.equal(result.resultados.length, 0);
  assert.equal(result.outcome, "manual");
  assert.match(result.detalhes, /portal oficial/i);
  assert.match(result.siteUrl, /gratuidade/);

  // Uncovered route
  const uncovered = await scrapeGontijo(
    "Curitiba",
    "PR",
    "Porto Alegre",
    "RS",
    today(),
    true,
  );
  assert.equal(uncovered.error, "COVERAGE_NOT_IMPLEMENTED");
});

test("Provider capabilities matrix correctly discriminates real adapter abilities", () => {
  assert.equal(PROVIDER_CAPABILITIES.ClickBus.hasVerifiedQuota, true);
  assert.equal(PROVIDER_CAPABILITIES.Guanabara.hasVerifiedQuota, true);
  assert.equal(PROVIDER_CAPABILITIES.Mobifacil.hasVerifiedQuota, false);
  assert.equal(PROVIDER_CAPABILITIES.Mobifacil.hasCommercialInventory, true);
  assert.equal(PROVIDER_CAPABILITIES.Gontijo.isManualGuidanceOnly, true);
  assert.equal(PROVIDER_CAPABILITIES.Gontijo.hasCommercialInventory, false);
  assert.equal(PROVIDER_CAPABILITIES.Buser.supportsIdJovemSearch, false);
});
