import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mobifacilPrice,
  parseMobifacilServices,
} from "../lib/scrapers/mobifacil/parser";
import { scrapeMobifacil } from "../lib/scrapers/mobifacil/client";

function html(items: unknown[]) {
  return `<div data-results="${JSON.stringify({ lsServicos: items }).replace(/"/g, "&quot;")}"></div>`;
}
test("Mobifacil preserves zero and cents without accepting ambiguous prices", () => {
  for (const [input, expected] of [
    ["0", 0],
    [0, 0],
    ["123,45", 123.45],
    ["1.234,56", 1234.56],
    ["10.13", 10.13],
    [10.13, 10.13],
  ] as const)
    assert.equal(mobifacilPrice(input), expected);
  for (const input of [
    null,
    undefined,
    "",
    "1.234",
    "10foo",
    "1e2",
    -1,
    Infinity,
    1.234,
    "1,234.56",
  ])
    assert.equal(mobifacilPrice(input), null);
});
test("Mobifacil distinguishes valid empty, broken markup, all-invalid and partial services", () => {
  assert.equal(parseMobifacilServices(html([])).state, "valid");
  for (const value of [
    "<h1>error</h1>",
    '"lsServicos": [',
    html([{ preco: "wrong" }]),
  ])
    assert.equal(parseMobifacilServices(value).state, "invalid");
  const result = parseMobifacilServices(
    html([{ preco: "123,45", empresa: 'Via "Teste" [x]' }, { preco: -1 }]),
  );
  assert.equal(result.state, "partial");
  assert.equal(result.rejected, 1);
  assert.equal(result.services[0].preco, 123.45);
});
test("Mobifacil adapter surfaces parser failure and preserves partial valid offers", async () => {
  const original = globalThis.fetch;
  let body = "<h1>unexpected page</h1>";
  globalThis.fetch = async () => new Response(body);
  try {
    const search = () =>
      scrapeMobifacil("Rio de Janeiro", "RJ", "Sao Paulo", "SP", "2026-12-01");
    assert.equal((await search()).error, "PROVIDER_INVALID_RESPONSE");
    body = html([]);
    assert.equal((await search()).error, undefined);
    body = html([{ preco: "0" }, { preco: "123,45" }, { preco: "bad" }]);
    const result = await search();
    assert.deepEqual(
      result.resultados.map((item) => item.valorNumerico),
      [0, 123.45],
    );
    assert.equal(result.coverage?.partial, true);
    assert.equal(result.resultados[0].classe, undefined);
  } finally {
    globalThis.fetch = original;
  }
});
