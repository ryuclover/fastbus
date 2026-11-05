import { test } from "node:test";
import assert from "node:assert/strict";
import { monitorSchema, today } from "../lib/monitoring/schema";
import { matches, type AlertPayload } from "../lib/monitoring/engine";
import { alertIsCurrent } from "../lib/monitoring/alert-validity";
import { validateProviderResult } from "../lib/scrapers/result-contract";

const cfg = {
  origin: "Manaus::AM",
  destination: "Sao Paulo::SP",
  benefit: "any" as const,
  maxPrice: 10.13,
  providers: ["Guanabara" as const],
  intervalMinutes: 1440,
  startDate: today(),
  endDate: today(),
};
const day = "2032-02-29",
  now = Date.parse("2032-02-29T03:30:00Z");
function check(raw: Record<string, unknown>) {
  return validateProviderResult(
    {
      provedor: "Guanabara",
      disponivel: true,
      vagasIdJovem: 1,
      detalhes: "ok",
      siteUrl: "",
      resultados: [
        { empresa: "Via", horario: "00:01", classe: "Convencional", ...raw },
      ],
    },
    "Guanabara",
    day,
    now,
    cfg,
  );
}
test("ceiling uses the known total in cents, including the boundary cent and a free fare with fees", () => {
  const item = check({
    valorNumerico: 0,
    fareMinor: 0,
    feesMinor: 1013,
    totalMinor: 1013,
    tipoGratuidade: "id_jovem_100",
    vagasIdJovem: 1,
  }).resultados[0];
  const brief = check({ valorNumerico: 1, validUntil: now + 1000 })
    .resultados[0];
  assert.ok(matches(brief, cfg, now + 999));
  assert.equal(matches(brief, cfg, now + 1000), false);
  assert.ok(matches(item, cfg, now));
  assert.equal(matches(item, { ...cfg, maxPrice: 10.12 }, now), false);
  assert.equal(
    check({ valorNumerico: 0, fareMinor: 0, feesMinor: 1200, totalMinor: 1013 })
      .error,
    "PROVIDER_INVALID_RESPONSE",
  );
  assert.equal(
    check({ valorNumerico: 10, tipoGratuidade: "id_jovem_50", vagasIdJovem: 0 })
      .error,
    "PROVIDER_INVALID_RESPONSE",
  );
  assert.equal(
    check({
      valorNumerico: 10,
      tipoGratuidade: "id_jovem_50",
      vagasIdJovem: 1,
      classe: "Leito",
    }).error,
    "PROVIDER_INVALID_RESPONSE",
  );
});
test("ID Jovem accepts an interstate route and rejects an intrastate one; commercial search accepts both", () => {
  assert.ok(monitorSchema.safeParse({ ...cfg, benefit: "id100" }).success);
  const local = { ...cfg, origin: "Campinas::SP" };
  assert.ok(monitorSchema.safeParse(local).success);
  assert.equal(
    monitorSchema.safeParse({ ...local, benefit: "id50" }).success,
    false,
  );
  assert.equal(
    monitorSchema.safeParse({ ...cfg, maxPrice: 10.125 }).success,
    false,
  );
});
test("arrival and departure use their respective zones and the date returned by the source", () => {
  const item = check({
    valorNumerico: 0,
    arrivalDate: "2032-03-01",
    chegada: "01:30",
  }).resultados[0];
  assert.equal(item.evidence?.departureAt, Date.parse("2032-02-29T04:01:00Z"));
  assert.equal(item.evidence?.arrivalAt, Date.parse("2032-03-01T04:30:00Z"));
  assert.equal(
    check({ valorNumerico: 0, arrivalDate: day, chegada: "00:30" }).error,
    "PROVIDER_INVALID_RESPONSE",
  );
  assert.equal(
    check({ valorNumerico: 0, chegada: "01:30" }).resultados[0].evidence
      ?.arrivalAt,
    null,
  );
});
import { parseProviderMoney, formatMoneyBrl } from "../lib/money";

test("old pending alerts are rechecked at departure, after freshness expiry and when proof is missing", () => {
  const payload: AlertPayload = {
    origin: cfg.origin,
    destination: cfg.destination,
    date: day,
    departure: "00:01",
    company: "Via",
    provider: "Guanabara",
    price: 0,
    benefit: "nenhuma",
    url: "https://viajeguanabara.com.br/",
    observedAt: now,
  };
  const dep = Date.parse("2032-02-29T04:01:00Z");
  assert.ok(alertIsCurrent(payload, dep - 1));
  assert.equal(alertIsCurrent(payload, dep), false);
  assert.equal(
    alertIsCurrent(payload, Date.parse("2032-03-01T03:30:00Z")),
    false,
  );
  assert.equal(
    alertIsCurrent({ ...payload, departure: "Consulte a fonte" }, now),
    false,
  );
  assert.equal(
    alertIsCurrent({ ...payload, observedAt: now - 86400000 }, now),
    false,
  );
  assert.equal(
    alertIsCurrent({ ...payload, benefit: "id_jovem_100" }, now),
    false,
  );
});

test("parseProviderMoney converts valid strings, floats and zeros to integer cents and rejects ambiguous/invalid inputs", () => {
  // Brazilian formats
  assert.equal(parseProviderMoney("123,45"), 12345);
  assert.equal(parseProviderMoney("1.234,56"), 123456);
  assert.equal(parseProviderMoney("12.345,67"), 1234567);
  assert.equal(parseProviderMoney("0,00"), 0);
  assert.equal(parseProviderMoney("0"), 0);
  assert.equal(parseProviderMoney(0), 0);
  assert.equal(parseProviderMoney("R$ 123,45"), 12345);
  assert.equal(parseProviderMoney("R$0,50"), 50);
  assert.equal(parseProviderMoney("BRL 100"), 10000);

  // Dot decimal formats
  assert.equal(parseProviderMoney("123.45"), 12345);
  assert.equal(parseProviderMoney("55.5"), 5550);
  assert.equal(parseProviderMoney(55.5), 5550);
  assert.equal(parseProviderMoney(10.13), 1013);

  // Currency formatting
  assert.equal(formatMoneyBrl(123456), "R$ 1.234,56");
  assert.equal(formatMoneyBrl(0), "R$ 0,00");
  assert.equal(formatMoneyBrl(1013), "R$ 10,13");

  // Rejections: ambiguous dot without decimals
  assert.equal(parseProviderMoney("1.234"), null);

  // Rejections: excessive precision (> 2 decimal places)
  assert.equal(parseProviderMoney(10.125), null);
  assert.equal(parseProviderMoney("10.125"), null);
  assert.equal(parseProviderMoney("10,125"), null);

  // Rejections: negative numbers, special strings, non-numeric
  assert.equal(parseProviderMoney(-1), null);
  assert.equal(parseProviderMoney("-10"), null);
  assert.equal(parseProviderMoney("-10,50"), null);
  assert.equal(parseProviderMoney("NaN"), null);
  assert.equal(parseProviderMoney("Infinity"), null);
  assert.equal(parseProviderMoney(""), null);
  assert.equal(parseProviderMoney("   "), null);
  assert.equal(parseProviderMoney(null), null);
  assert.equal(parseProviderMoney(undefined), null);
  assert.equal(parseProviderMoney(true), null);
  assert.equal(parseProviderMoney({}), null);
});

test("a verified remaining youth seat can trigger an alert until the provider deadline", () => {
  const deadline = now + 60000;
  const item = check({
    valorNumerico: 0,
    tipoGratuidade: "id_jovem_100",
    vagasIdJovem: 1,
    validUntil: deadline,
    linkCompra: "https://viajeguanabara.com.br/",
  }).resultados[0];
  assert.ok(matches(item, { ...cfg, benefit: "id100" }, now));
  const payload: AlertPayload = {
    origin: cfg.origin,
    destination: cfg.destination,
    date: day,
    departure: item.horario!,
    provider: "Guanabara",
    company: "Via",
    price: 0,
    benefit: "id_jovem_100",
    url: item.linkCompra!,
    evidence: item.evidence,
    observedAt: now,
  };
  assert.ok(alertIsCurrent(payload, deadline - 1));
  assert.equal(alertIsCurrent(payload, deadline), false);
});
