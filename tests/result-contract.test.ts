import { test } from "node:test";
import assert from "node:assert/strict";
import { validateProviderResult } from "../lib/scrapers/result-contract";

const date = "2026-12-01";
function parse(resultados: unknown[], extra = {}) {
  return validateProviderResult(
    {
      disponivel: true,
      vagasIdJovem: 0,
      detalhes: "ok",
      siteUrl: "",
      provedor: "ClickBus",
      resultados,
      ...extra,
    },
    "ClickBus",
    date,
    123,
  );
}
test("invalid items do not discard valid zero-price offers and partiality survives serialization", () => {
  const result = parse([
    { empresa: "Via", valorNumerico: 0 },
    { empresa: "Via", valorNumerico: NaN },
  ]);
  assert.equal(result.disponivel, true);
  assert.equal(result.resultados[0].valorNumerico, 0);
  assert.equal(result.resultados[0].priceMinor, 0);
  assert.equal(
    parse([{ empresa: "Via", valorNumerico: 12.34, priceMinor: 1 }])
      .resultados[0].priceMinor,
    1234,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)).validation, {
    version: 1,
    observedAt: 123,
    received: 2,
    accepted: 1,
    rejected: 1,
    state: "partial",
  });
});
test("invalid money, seats, dates and identities cannot become valid offers", () => {
  for (const item of [
    { empresa: "Via", valorNumerico: Infinity },
    { empresa: "Via", valorNumerico: -1 },
    { empresa: "Via", valorNumerico: 1.234 },
    { empresa: "Via", vagasIdJovem: -1 },
    { empresa: "Via", data: "2026-02-30" },
    { empresa: "Via", data: "2026-12-02" },
    { valorNumerico: 10 },
  ])
    assert.equal(parse([item]).error, "PROVIDER_INVALID_RESPONSE");
  assert.equal(
    parse([], { provedor: "Buser" }).error,
    "PROVIDER_INVALID_RESPONSE",
  );
});
test("empty is valid, missing data stays missing, and extra payload fields are stripped", () => {
  assert.equal(parse([]).validation?.state, "valid");
  const item = parse([{ empresa: "Via", secret: "discard" }]).resultados[0];
  assert.equal(item.valorNumerico, undefined);
  assert.ok(!("secret" in item));
  assert.equal(item.evidence?.totalMinor, null);
  assert.equal(
    parse([{ empresa: "Via" }], { error: "PROVIDER_BLOCKED" }).disponivel,
    false,
  );
});
test("coverage counters are validated and remain distinct from valid output items", () => {
  const coverage = { candidates: 8, checked: 6, unconfirmed: 1, partial: true };
  assert.deepEqual(
    parse([{ empresa: "Via" }], { coverage }).coverage,
    coverage,
  );
  for (const invalid of [
    { ...coverage, checked: 9 },
    { ...coverage, unconfirmed: 7 },
    { ...coverage, partial: false },
  ])
    assert.equal(
      parse([], { coverage: invalid }).error,
      "PROVIDER_INVALID_RESPONSE",
    );
});

test("malformed envelopes and excessive arrays fail closed", () => {
  assert.equal(
    validateProviderResult(null, "ClickBus", date, 123).error,
    "PROVIDER_INVALID_RESPONSE",
  );
  assert.equal(
    parse(Array.from({ length: 1001 }, () => ({ empresa: "Via" }))).error,
    "PROVIDER_INVALID_RESPONSE",
  );
});

test("offer evidence distinguishes known price, estimated validity and unknown terminal", () => {
  const observed = Date.parse("2026-12-01T13:00:00Z");
  const raw = {
    disponivel: true,
    provedor: "ClickBus",
    detalhes: "ok",
    siteUrl: "",
    vagasIdJovem: 1,
    resultados: [
      {
        empresa: "Via",
        horario: "12:00",
        valorNumerico: 0,
        classe: "Convencional",
        tipoGratuidade: "id_jovem_100",
        vagasIdJovem: 1,
      },
    ],
  };
  const result = validateProviderResult(raw, "ClickBus", date, observed, {
    origin: "São Paulo::SP",
    destination: "Rio::RJ",
  });
  const evidence = result.resultados[0].evidence!;
  assert.equal(result.outcome, "offers");
  assert.equal(evidence.departureAt, Date.parse("2026-12-01T15:00:00Z"));
  assert.equal(evidence.expiresAt, evidence.departureAt);
  assert.equal(evidence.currency, "BRL");
  assert.equal(evidence.quotedMinor, 0);
  assert.equal(evidence.totalMinor, null);
  assert.equal(evidence.origin.terminal, null);
  assert.deepEqual(evidence.benefitEvidence, {
    kind: "checkout-quota",
    percentage: 100,
    seats: 1,
  });
  const another = validateProviderResult(
    raw,
    "ClickBus",
    date,
    observed + 100,
    { origin: "São Paulo::SP", destination: "Rio::RJ" },
  );
  assert.equal(evidence.id, another.resultados[0].evidence?.id);
  assert.equal(
    validateProviderResult(raw, "ClickBus", date, observed, {
      origin: "Cidade::AM",
      destination: "Rio::RJ",
    }).resultados[0].evidence?.departureAt,
    null,
  );
});
