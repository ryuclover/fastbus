import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parseClickBusTripPage,
  parseClickBusQuotas,
} from "../lib/scrapers/clickbus/benefits";
import { converterTripsClickBus } from "../lib/scrapers/clickbus/client";

for (const name of [
  "2026-11-18-online",
  "2026-11-18-manual",
  "2026-11-19-exhausted",
  "2026-11-20-manual",
]) {
  test(`observed ClickBus page agrees with the visible benefit flow: ${name}`, async () => {
    const fixture = JSON.parse(
      readFileSync(
        new URL(`./fixtures/clickbus/${name}.json`, import.meta.url),
        "utf8",
      ),
    );
    assert.equal(fixture.date, name.slice(0, 10));
    const data = `1:${JSON.stringify({ children: ["$", "component", null, { trips: [fixture.pageTrip] }] })}\n`;
    const html = `<script>self.__next_f.push(${JSON.stringify([1, data])})</script>`;
    const parsed = parseClickBusTripPage(html, fixture.tripId);
    if (fixture.expectedUi) {
      assert.equal(parsed?.vagas100, fixture.expectedUi.full);
      assert.equal(parsed?.vagas50, fixture.expectedUi.partial);
    } else assert.equal(parsed, null);
    assert.equal(parseClickBusTripPage(html, "wrong-trip"), null);
    const result = await converterTripsClickBus(
      [fixture.searchTrip],
      "Rio de Janeiro",
      "RJ",
      "Sao Paulo",
      "SP",
      fixture.date,
      "https://www.clickbus.com.br/",
      true,
      async () => parsed,
    );
    assert.equal(result.resultados.length, fixture.expectedUi?.full ? 2 : 0);
  });
}

test("available seats override nominal quota; explicit unknown availability cannot fall back to amount", () => {
  assert.equal(
    parseClickBusQuotas({
      youngIdFullPrice: { amount: 2, availableSeats: 0, price: 0 },
    })?.vagas100,
    0,
  );
  assert.equal(
    parseClickBusQuotas({
      youngIdFullPrice: { amount: 2, availableSeats: null, price: 0 },
    }),
    null,
  );
});
