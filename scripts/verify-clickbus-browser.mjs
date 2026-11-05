// Run with: node --import tsx scripts/verify-clickbus-browser.mjs
// Uses an unpacked, locally supplied Browsec extension in an isolated test profile.
import { chromium } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ClickBusSession } from "../lib/scrapers/clickbus/client.ts";
import { withRequestBudget } from "../lib/monitoring/request-budget.ts";
import { closeProviderProxies } from "../lib/monitoring/proxy.ts";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

async function main() {
  let pauseUntil = 0;
  for (const file of [
    "clickbus-id-jovem-live.json",
    "clickbus-id-jovem-browser.json",
  ]) {
    try {
      const previous = JSON.parse(
        await readFile(`docs/diagnostics/${file}`, "utf8"),
      );
      pauseUntil = Math.max(pauseUntil, previous?.budget?.blockedUntil || 0);
    } catch {
      /* First diagnostic. */
    }
  }
  const databasePath = path.resolve(
    process.env.FASTBUS_DATA_DIR || "data",
    "fastbus.sqlite",
  );
  if (existsSync(databasePath)) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      pauseUntil = Math.max(
        pauseUntil,
        database
          .prepare("SELECT next_at FROM providers WHERE id='ClickBus'")
          .get()?.next_at || 0,
      );
    } finally {
      database.close();
    }
  }
  if (pauseUntil > Date.now())
    throw Error(
      `Pausa da fonte ativa até ${new Date(pauseUntil).toISOString()}; nenhuma requisição enviada.`,
    );
  const extension = process.env.BROWSEC_EXTENSION_PATH;
  const executablePath = process.env.CLICKBUS_TEST_CHROME_PATH;
  if (!extension || !executablePath)
    throw Error(
      "Configure BROWSEC_EXTENSION_PATH e CLICKBUS_TEST_CHROME_PATH para o Chromium de teste.",
    );
  const report = {
    testedAt: new Date().toISOString(),
    transport:
      "Isolated Chromium + Browsec, United States; existing adapter via browser HTTP bridge",
    route: {
      origin: "Rio de Janeiro::RJ",
      destination: "Sao Paulo::SP",
      date:
        process.env.CLICKBUS_TEST_DATE ||
        new Date(Date.now() + 31 * 86400000).toISOString().slice(0, 10),
    },
    requests: [],
  };
  // Match the current adapter's signing input; this is a diagnostic, not a browser fingerprint bypass.
  const userAgent =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
  const context = await chromium.launchPersistentContext(
    path.resolve("scratch/clickbus-browser-profile"),
    {
      executablePath,
      headless: true,
      userAgent,
      args: [
        `--disable-extensions-except=${path.resolve(extension)}`,
        `--load-extension=${path.resolve(extension)}`,
      ],
    },
  );
  const original = globalThis.fetch;
  try {
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker", { timeout: 20000 }));
    const popup = await context.newPage();
    await popup.goto(
      `chrome-extension://${new URL(worker.url()).host}/popup/popup.html`,
    );
    await popup.waitForTimeout(2000);
    const accept = popup.getByText("Accept", { exact: true });
    if (await accept.isVisible()) await accept.click();
    const start = popup.getByRole("button", { name: "Start VPN", exact: true });
    if (await start.isVisible())
      await start.click({ force: true, timeout: 5000 });
    await popup.waitForTimeout(4000);
    await popup.getByText("Change", { exact: true }).click();
    await popup.getByText("United States", { exact: true }).first().click();
    await popup.waitForTimeout(4000);
    const settings = await worker.evaluate(async () =>
      chrome.proxy.settings.get({ incognito: false }),
    );
    if (settings.value.mode !== "pac_script")
      throw Error("Proxy da extensão não está ativo.");
    const geoPage = await context.newPage();
    await geoPage.goto("https://api.country.is/", {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    report.observedCountry = JSON.parse(
      await geoPage.locator("body").innerText(),
    ).country;
    await geoPage.close();
    if (report.observedCountry !== "US")
      throw Error("Saída dos EUA não confirmada; nenhum acesso ao ClickBus.");
    await mkdir("scratch/clickbus-validation", { recursive: true });
    globalThis.fetch = async (input, options = {}) => {
      const url = new URL(String(input));
      if (
        !["www.clickbus.com.br", "bff.clickbus.com"].includes(url.hostname) ||
        (options.method && options.method !== "GET")
      )
        throw Error("Diagnostic allows only public ClickBus GET requests");
      options.signal?.throwIfAborted();
      const page = await context.newPage();
      // Raw documents only: no page scripts, assets, seats, checkout or additional API requests.
      await page.route("**/*", (route) => {
        const request = route.request();
        const target = new URL(request.url());
        return request.isNavigationRequest() &&
          request.frame() === page.mainFrame() &&
          ["www.clickbus.com.br", "bff.clickbus.com"].includes(target.hostname)
          ? route.continue()
          : route.abort();
      });
      const onAbort = () => {
        void page.close().catch(() => {});
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const startedAt = Date.now();
      try {
        await page.setExtraHTTPHeaders(
          Object.fromEntries(new Headers(options.headers)),
        );
        const response = await page.goto(url.toString(), {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });
        if (!response) throw Error("No HTTP response");
        const body = await response.body();
        const entry = {
          hostname: url.hostname,
          path: url.pathname,
          startedAt,
          status: response.status(),
          bytes: body.length,
        };
        report.requests.push(entry);
        console.log(JSON.stringify(entry));
        await writeFile(
          `scratch/clickbus-validation/browsec-${report.requests.length}.txt`,
          body,
        );
        const headers = await response.allHeaders();
        delete headers["content-encoding"];
        delete headers["content-length"];
        return new Response(body, { status: response.status(), headers });
      } finally {
        options.signal?.removeEventListener("abort", onAbort);
        await page.close().catch(() => {});
      }
    };
    if (existsSync(databasePath)) {
      const database = new DatabaseSync(databasePath);
      try {
        const reserved = database
          .prepare(
            "INSERT INTO providers(id,next_at,failures) VALUES ('ClickBus',?,0) ON CONFLICT(id) DO UPDATE SET next_at=excluded.next_at WHERE providers.next_at<=? RETURNING id",
          )
          .get(Date.now() + 7 * 60000, Date.now());
        if (!reserved)
          throw Error(
            "Outra consulta reservou a fonte; diagnóstico interrompido sem acesso ao ClickBus.",
          );
      } finally {
        database.close();
      }
    }
    const { result, budget } = await withRequestBudget(() =>
      new ClickBusSession().buscarData(
        "Rio de Janeiro",
        "RJ",
        "Sao Paulo",
        "SP",
        report.route.date,
        true,
      ),
    );
    report.budget = {
      count: budget.count,
      blockedUntil: budget.blockedUntil,
      limited: budget.limited,
    };
    report.result = result;
    if (budget.blockedUntil && existsSync(databasePath)) {
      const database = new DatabaseSync(databasePath);
      try {
        database
          .prepare(
            "INSERT INTO providers(id,next_at,failures) VALUES ('ClickBus',?,1) ON CONFLICT(id) DO UPDATE SET next_at=MAX(providers.next_at,excluded.next_at),failures=MAX(providers.failures,1)",
          )
          .run(budget.blockedUntil);
      } finally {
        database.close();
      }
    }
    console.log(
      JSON.stringify({
        offers: result.resultados.length,
        error: result.error,
        budget: report.budget,
      }),
    );
  } catch (error) {
    report.diagnosticError = error.message.split("\n")[0];
    throw error;
  } finally {
    globalThis.fetch = original;
    await mkdir("docs/diagnostics", { recursive: true });
    await writeFile(
      "docs/diagnostics/clickbus-id-jovem-browser.json",
      JSON.stringify(report, null, 2) + "\n",
    );
    await closeProviderProxies();
    await context.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
