import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
import { mkdir, writeFile } from "node:fs/promises";
import { db } from "../../server/database";
import { withRequestBudget } from "../../monitoring/request-budget";
import { closeProviderProxies } from "../../monitoring/proxy";
import { ClickBusBrowserSession, closeClickBusBrowser } from "./browser";
/** One bounded, read-only browser observation. Never exports cookies or signed headers. */
export async function mapClickbus(
  originSlug = "rio-de-janeiro-rj-todos",
  destinationSlug = "sao-paulo-sp-todos",
  date = new Date(Date.now() + 31 * 86400000).toISOString().slice(0, 10),
  benefit = true,
) {
  const parse = (slug: string) => {
    const match = /^([a-z]+(?:-[a-z]+)*)-([a-z]{2})(?:-todos)?$/.exec(slug);
    if (!match) throw new Error("Slug de cidade inválido.");
    return { city: match[1].replace(/-/g, " "), uf: match[2].toUpperCase() };
  };
  const origin = parse(originSlug),
    destination = parse(destinationSlug);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date ||
    Date.parse(date) < Date.now() - 86400000 ||
    Date.parse(date) > Date.now() + 365 * 86400000
  )
    throw new Error(
      "Informe uma data futura válida, com até um ano de antecedência.",
    );
  const reserved = await db()
    .prepare(
      "INSERT INTO providers(id,next_at,failures) VALUES ('ClickBus',?,0) ON CONFLICT(id) DO UPDATE SET next_at=excluded.next_at WHERE providers.next_at<=? RETURNING id",
    )
    .get(Date.now() + 7 * 60000, Date.now());
  if (!reserved)
    throw new Error(
      "ClickBus em pausa ou com outra consulta reservada; nenhuma requisição enviada.",
    );
  try {
    const { result, budget } = await withRequestBudget(() =>
      new ClickBusBrowserSession().buscarData(
        origin.city,
        origin.uf,
        destination.city,
        destination.uf,
        date,
        benefit,
      ),
    );
    if (result.error) {
      const previous = (await db()
        .prepare("SELECT failures FROM providers WHERE id='ClickBus'")
        .get()) as {
        failures: number;
      };
      const failures = previous.failures + 1;
      const next = Math.max(
        budget.blockedUntil,
        Date.now() +
          Math.min(1440, 15 * 2 ** Math.min(failures - 1, 7)) * 60000,
      );
      await db()
        .prepare(
          "UPDATE providers SET next_at=MAX(next_at,?),failures=? WHERE id='ClickBus'",
        )
        .run(next, failures);
    } else
      await db()
        .prepare("UPDATE providers SET failures=0 WHERE id='ClickBus'")
        .run();
    const report = {
      capturedAt: new Date().toISOString(),
      transport: "official-browser-flow",
      origin: originSlug,
      destination: destinationSlug,
      date,
      confirmedOffers: result.resultados.length,
      error: result.error || null,
      budget: {
        count: budget.count,
        blockedUntil: budget.blockedUntil,
        limited: budget.limited,
      },
      result,
    };
    await mkdir("docs/diagnostics", { recursive: true });
    await writeFile(
      "docs/diagnostics/clickbus-latest-observation.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    if (result.error || !result.resultados.length) {
      console.log(
        "Observação inconclusiva ou sem ofertas confirmadas; o mapeamento validado não foi sobrescrito.",
      );
    } else {
      await writeFile(
        "lib/scrapers/clickbus/mapped-api.json",
        JSON.stringify(report, null, 2) + "\n",
      );
      console.log(
        `${result.resultados.length} oferta(s) confirmada(s), ${budget.count} requisições. Sem reserva de poltronas ou envio de WhatsApp.`,
      );
    }
    return report;
  } finally {
    await closeClickBusBrowser();
    await closeProviderProxies();
  }
}
if (process.argv[1]?.replace(/\\/g, "/").endsWith("/clickbus/mapper.ts")) {
  mapClickbus(undefined, undefined, process.argv[2]).catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Falha na observação.",
    );
    process.exitCode = 1;
  });
}
