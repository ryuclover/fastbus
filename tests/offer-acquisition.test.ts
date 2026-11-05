import { test } from "node:test";
import assert from "node:assert/strict";
import { adaptadoresProvedores } from "../lib/services/provedores";
import { compararPrecosIntervalo } from "../lib/services/comparador-intervalo";
import { converterTripsClickBus } from "../lib/scrapers/clickbus/client";
import { cidadesSugeridas } from "../lib/cidades-sugeridas";
import { validateProviderResult } from "../lib/scrapers/result-contract";
const ctx = {
  origem: "Rio de Janeiro",
  origemUF: "RJ",
  destino: "Sao Paulo",
  destinoUF: "SP",
  dataIso: "2030-12-01",
  idJovem: false,
};
test("registry and interval comparison preserve Embarca identity, partial coverage and commercial zero", async () => {
  const old = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json([
      null,
      {
        id: 123,
        price: "0.00",
        operator_name: "Via",
        departure_at: "2030-12-01T08:30:00-03:00",
      },
    ]);
  try {
    const result = await adaptadoresProvedores.Embarca.consultar(ctx);
    assert.equal(result.outcome, "partial");
    assert.equal(result.coverage?.unconfirmed, 1);
    assert.equal(result.resultados[0].evidence?.sourceTripId, "123");
    const comparison = await compararPrecosIntervalo({
      ...ctx,
      dataInicio: ctx.dataIso,
      dataFim: ctx.dataIso,
      provedores: ["Embarca"],
    });
    assert.equal(comparison.todasViagens[0].evidence?.provider, "Embarca");
    assert.equal(comparison.resumoPorDia[0].temIdJovem100, false);
    assert.equal(comparison.statusProvedores[0].status, "inconclusivo");
    assert.equal(
      (await adaptadoresProvedores.Gontijo.consultar(ctx)).outcome,
      "manual",
    );
  } finally {
    globalThis.fetch = old;
  }
});
test("ClickBus isolates malformed raw trips and only describes the verified segment", async () => {
  const station = {
    city: "Rio de Janeiro",
    state: "RJ",
    time: "10:30",
    id: "terminal1",
    name: "Rodoviária",
  };
  const trips = [
    null,
    { uuid: "bad", price: "garbage" },
    {
      uuid: "valid",
      price: "9.53",
      parts: [
        { departure: station, arrival: { city: "Sao Paulo", state: "SP" } },
      ],
    },
  ];
  const result = await converterTripsClickBus(
    trips,
    ctx.origem,
    "RJ",
    ctx.destino,
    "SP",
    ctx.dataIso,
    "https://www.clickbus.com.br/",
    false,
  );
  assert.equal(result.coverage.unconfirmed, 2);
  assert.equal(result.coverage.partial, true);
  assert.equal(result.resultados[0].originStop?.id, "terminal1");
  assert.equal(result.resultados[0].segments?.length, 1);
});
test("all supported origin cities resolve local departures independent of server timezone", () => {
  for (const city of cidadesSugeridas) {
    const result = validateProviderResult(
      {
        provedor: "Buser",
        siteUrl: "",
        disponivel: true,
        detalhes: "ok",
        vagasIdJovem: 0,
        resultados: [{ empresa: "Via", horario: "23:30", valorNumerico: 5 }],
      },
      "Buser",
      ctx.dataIso,
      0,
      { origin: city.nome + "::" + city.uf, destination: "Rio::RJ" },
    );
    assert.ok(result.resultados[0].evidence?.departureAt, city.nome);
  }
});
