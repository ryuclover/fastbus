import { chromium, type BrowserContext, type Page } from "playwright-core";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  currentMonitoringBudget,
  runMonitoredRequest,
  checkMonitoringResponse,
  blockMonitoringRequests,
  type RequestBudget,
} from "../../monitoring/request-budget";
import {
  resolverSlugClickBus,
  clickBusTripUrl,
  converterTripsClickBus,
} from "./client";
import { isClickBusChallengeHtml, parseClickBusTripPage } from "./benefits";
import type { ScraperResult } from "../types";
import { diagnosticCode } from "../../monitoring/diagnostics";
import { freeBrowserEgress } from "../../monitoring/free-egress";
import { publicBrowserEnvironment } from "../../monitoring/browser-environment";
import { prepareExtensionControls } from "./extension-controls";

let contextPromise: Promise<BrowserContext> | undefined;
const controlPages = new WeakMap<BrowserContext, Page>();
const directContexts = new WeakSet<BrowserContext>();
async function assertProxy(context: BrowserContext) {
  if (directContexts.has(context)) return;
  const popup = controlPages.get(context);
  if (!popup || popup.isClosed()) throw new Error("CLICKBUS_VPN_NOT_CONNECTED");
  const settings = await popup.evaluate(async () => {
    const api = (
      globalThis as unknown as {
        chrome: {
          proxy: {
            settings: {
              get: (input: object) => Promise<{ value: { mode: string } }>;
            };
          };
        };
      }
    ).chrome;
    return api.proxy.settings.get({ incognito: false });
  });
  if (settings.value.mode !== "pac_script")
    throw new Error("CLICKBUS_VPN_NOT_CONNECTED");
}
async function openContext() {
  const egress = freeBrowserEgress();
  const executablePath = process.env.CLICKBUS_BROWSER_PATH;
  const extension = process.env.CLICKBUS_BROWSEC_EXTENSION_PATH;
  const direct = process.env.CLICKBUS_NETWORK_MODE === "direct";
  if (!executablePath || (!extension && !direct))
    throw new Error("CLICKBUS_BROWSER_NOT_CONFIGURED");
  const profile = path.resolve(
    process.env.FASTBUS_RUNTIME_DIR || "data/runtime",
    direct ? "clickbus" : `clickbus-${egress.code.toLowerCase()}`,
  );
  await mkdir(profile, { recursive: true });
  const context = await chromium.launchPersistentContext(profile, {
    executablePath,
    timeout: 20000,
    chromiumSandbox: true,
    env: publicBrowserEnvironment(),
    ignoreDefaultArgs: ["--disable-extensions"],
    headless: process.env.CLICKBUS_BROWSER_HEADLESS !== "false",
    viewport: { width: 1440, height: 1040 },
    args: [
      "--disable-gpu",
      ...(direct
        ? []
        : [
            `--disable-extensions-except=${path.resolve(extension!)}`,
            `--load-extension=${path.resolve(extension!)}`,
          ]),
    ],
  });
  if (direct) {
    directContexts.add(context);
    return context;
  }
  let stage = "CLICKBUS_EXTENSION_STARTUP";
  try {
    const worker =
      context.serviceWorkers()[0] ||
      (await context.waitForEvent("serviceworker", { timeout: 15000 }));
    stage = "CLICKBUS_EXTENSION_UI_READY";
    const popup = await context.newPage();
    await popup.goto(
      `chrome-extension://${new URL(worker.url()).host}/popup/popup.html`,
      { timeout: 15000 },
    );
    const { accept, start, ready } = await prepareExtensionControls(popup);
    await accept
      .or(ready)
      .filter({ visible: true })
      .first()
      .waitFor({ state: "visible", timeout: 15000 });
    if (await accept.isVisible()) {
      stage = "CLICKBUS_EXTENSION_ACCEPTED";
      await accept.click();
      await ready.waitFor({ state: "visible", timeout: 15000 });
    }
    stage = "CLICKBUS_EXTENSION_CONNECT";
    if (await start.isVisible()) await start.click({ timeout: 5000 });
    await popup
      .getByText("Change", { exact: true })
      .waitFor({ state: "visible", timeout: 15000 });
    stage = "CLICKBUS_EXTENSION_COUNTRY";
    await popup.getByText("Change", { exact: true }).click({ timeout: 10000 });
    await popup
      .getByText(egress.label, { exact: true })
      .first()
      .click({ timeout: 10000 });
    stage = "CLICKBUS_EXTENSION_PROXY_READY";
    await popup.waitForFunction(
      async () => {
        const api = (
          globalThis as unknown as {
            chrome: {
              proxy: {
                settings: {
                  get: (input: object) => Promise<{ value: { mode: string } }>;
                };
              };
            };
          }
        ).chrome;
        return (
          (await api.proxy.settings.get({ incognito: false })).value.mode ===
          "pac_script"
        );
      },
      undefined,
      { timeout: 10000 },
    );
    const settings = await worker.evaluate(async () => {
      const api = (
        globalThis as unknown as {
          chrome: {
            proxy: {
              settings: {
                get: (input: object) => Promise<{ value: { mode: string } }>;
              };
            };
          };
        }
      ).chrome;
      return api.proxy.settings.get({ incognito: false });
    });
    if (settings.value.mode !== "pac_script")
      throw new Error("CLICKBUS_VPN_NOT_CONNECTED");
    controlPages.set(context, popup);
    stage = "CLICKBUS_PROXY_GEOLOCATION";
    const geo = await context.newPage();
    try {
      await geo.goto("https://api.country.is/", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
      const country: unknown = JSON.parse(
        await geo.locator("body").innerText(),
      );
      if (
        !country ||
        typeof country !== "object" ||
        (country as { country?: string }).country !== egress.code
      )
        throw new Error("CLICKBUS_VPN_COUNTRY_UNCONFIRMED");
    } finally {
      await geo.close();
    }
    return context;
  } catch (error) {
    if (process.env.FASTBUS_VPN_PROBE_VERBOSE === "1") {
      const popup = context
        .pages()
        .find((page) => page.url().startsWith("chrome-extension://"));
      if (popup) {
        await popup
          .screenshot({ path: "/tmp/fastbus-vpn-popup.png" })
          .catch(() => {});
        console.error(
          "VPN_SETUP_CONTROLS",
          await popup
            .locator("button, [role=button], .ChangeButton")
            .filter({ visible: true })
            .allTextContents()
            .catch(() => []),
        );
      }
    }
    await context.close();
    throw new Error(`${stage}_${diagnosticCode(error)}`);
  }
}
/** Checks browser/extension setup without issuing a request to ClickBus. */
export async function checkClickBusBrowser() {
  const context = await browserContext();
  if (process.env.FASTBUS_VPN_PROBE_VERBOSE === "1") {
    await controlPages
      .get(context)
      ?.screenshot({ path: "/tmp/fastbus-vpn-connected.png" });
  }
}
async function browserContext() {
  if (!contextPromise) {
    const pending = openContext();
    contextPromise = pending;
    void pending.then(
      (context) => {
        context.once("close", () => {
          if (contextPromise === pending) contextPromise = undefined;
        });
      },
      () => {
        if (contextPromise === pending) contextPromise = undefined;
      },
    );
  }
  return contextPromise;
}
export async function closeClickBusBrowser() {
  if (!contextPromise) return;
  const pending = contextPromise;
  contextPromise = undefined;
  await (await pending.catch(() => null))?.close();
}

function marketRequest(url: URL, navigation: boolean) {
  return (
    url.hostname === "bff.clickbus.com" ||
    (url.hostname === "www.clickbus.com.br" && navigation)
  );
}
async function preparePage(
  context: BrowserContext,
  budget: RequestBudget,
  documentsOnly = false,
) {
  const page = await context.newPage();
  let failure: Error | undefined;
  const abort = () => {
    void page.close().catch(() => {});
  };
  budget.signal.addEventListener("abort", abort, { once: true });
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (["image", "font", "media"].includes(request.resourceType()))
      return route.abort();
    if (documentsOnly && !request.isNavigationRequest()) return route.abort();
    if (!marketRequest(url, request.isNavigationRequest()))
      return route.continue();
    if (failure || budget.signal.aborted) return route.abort();
    try {
      await runMonitoredRequest(async () => {
        await assertProxy(context);
        await route.continue();
        const response = await request.response();
        if (response)
          checkMonitoringResponse(
            response.status(),
            response.headers()["retry-after"] || null,
            budget,
            {
              challenge: response.headers()["cf-mitigated"],
              serverDate: response.headers()["date"],
            },
          );
      }, budget);
    } catch (error) {
      failure =
        error instanceof Error ? error : new Error("CLICKBUS_NETWORK_ERROR");
      await route.abort().catch(() => {});
    }
  });
  return {
    page,
    error: () => failure,
    close: async () => {
      budget.signal.removeEventListener("abort", abort);
      await page.close().catch(() => {});
    },
  };
}

export class ClickBusBrowserSession {
  async buscarData(
    origin: string,
    originUF: string,
    destination: string,
    destinationUF: string,
    date: string,
    benefit = false,
  ): Promise<ScraperResult> {
    const empty: ScraperResult = {
      disponivel: false,
      vagasIdJovem: 0,
      detalhes: "Não foi possível confirmar a consulta no ClickBus.",
      siteUrl: "https://www.clickbus.com.br/",
      provedor: "ClickBus",
      empresa: "ClickBus",
      dataConsultada: date,
      resultados: [],
    };
    const budget = currentMonitoringBudget();
    if (!budget) return { ...empty, error: "MONITORING_BUDGET_REQUIRED" };
    let search: Awaited<ReturnType<typeof preparePage>> | undefined;
    try {
      budget.signal.throwIfAborted();
      const from = await resolverSlugClickBus(origin, originUF),
        to = await resolverSlugClickBus(destination, destinationUF);
      const url = new URL(`https://www.clickbus.com.br/onibus/${from}/${to}`);
      url.searchParams.set("departureDate", date);
      if (benefit) url.searchParams.set("gratuity", "true");
      empty.siteUrl = url.toString();
      const context = await browserContext();
      budget.signal.throwIfAborted();
      search = await preparePage(context, budget);
      const apiResponse = search.page
        .waitForResponse(
          (response) => {
            const target = new URL(response.url());
            return (
              target.hostname === "bff.clickbus.com" &&
              /^\/web\/api\/v\d+\/trips\/?$/.test(target.pathname) &&
              target.searchParams.get("departureDate")?.slice(0, 10) === date &&
              target.searchParams.get("from")?.replace(/-todos$/, "") ===
                from.replace(/-todos$/, "") &&
              target.searchParams.get("to")?.replace(/-todos$/, "") ===
                to.replace(/-todos$/, "")
            );
          },
          { timeout: 60000 },
        )
        .then((response) => ({ response, error: null }))
        .catch((error) => ({ response: null, error }));
      // Observe a blocked document before waiting for an API it will never call.
      const document = await search.page.goto(url.toString(), {
        waitUntil: "domcontentloaded",
        timeout: 60000,
      });
      if (document)
        checkMonitoringResponse(
          document.status(),
          document.headers()["retry-after"] || null,
          budget,
          {
            challenge: document.headers()["cf-mitigated"],
            serverDate: document.headers()["date"],
          },
        );
      if (document && isClickBusChallengeHtml(await document.text())) {
        blockMonitoringRequests(undefined, budget);
        throw new Error("PROVIDER_BLOCKED");
      }
      const api = await apiResponse;
      if (!api.response) throw new Error("CLICKBUS_TRIPS_RESPONSE_TIMEOUT");
      const response = api.response;
      checkMonitoringResponse(
        response.status(),
        response.headers()["retry-after"] || null,
        budget,
        {
          challenge: response.headers()["cf-mitigated"],
          serverDate: response.headers()["date"],
        },
      );
      if (!response.ok()) throw new Error("CLICKBUS_QUERY_FAILED");
      const data = await response.json();
      if (!data || !Array.isArray(data.trips))
        throw new Error("CLICKBUS_INVALID_RESPONSE");
      const converted = await converterTripsClickBus(
        data.trips,
        origin,
        originUF,
        destination,
        destinationUF,
        date,
        url.toString(),
        benefit,
        async (tripId) => {
          const detail = await preparePage(context, budget, true);
          try {
            const document = await detail.page.goto(clickBusTripUrl(tripId), {
              waitUntil: "domcontentloaded",
              timeout: 15000,
            });
            if (detail.error()) throw detail.error();
            if (!document) return null;
            checkMonitoringResponse(
              document.status(),
              document.headers()["retry-after"] || null,
              budget,
              {
                challenge: document.headers()["cf-mitigated"],
                serverDate: document.headers()["date"],
              },
            );
            if (!document.ok()) return null;
            const html = await document.text();
            if (isClickBusChallengeHtml(html)) {
              blockMonitoringRequests(undefined, budget);
              throw new Error("PROVIDER_BLOCKED");
            }
            return parseClickBusTripPage(html, tripId);
          } finally {
            await detail.close();
          }
        },
      );
      if (search.error()) throw search.error();
      if (budget.blockedUntil) throw new Error("PROVIDER_BLOCKED");
      const manualOnly =
        benefit &&
        !converted.resultados.length &&
        data.trips.some(
          (trip: {
            options?: {
              isGratuityTrip?: boolean;
              hasGratuityCheckout?: boolean;
            };
          }) =>
            trip?.options?.isGratuityTrip === true &&
            trip.options.hasGratuityCheckout !== true,
        );
      return {
        ...empty,
        disponivel: converted.resultados.length > 0,
        resultados: converted.resultados,
        coverage: converted.coverage,
        vagasIdJovem: converted.resultados.reduce(
          (sum, item) => sum + (item.vagasIdJovem || 0),
          0,
        ),
        error:
          !converted.resultados.length &&
          (converted.partial || converted.unconfirmed || manualOnly)
            ? "ID_JOVEM_UNCONFIRMED"
            : undefined,
        detalhes: `${converted.resultados.length} oferta(s) confirmada(s)${manualOnly ? "; existem viagens que exigem solicitação manual do benefício" : converted.partial || converted.unconfirmed ? "; verificação parcial das cotas" : ""}.`,
      };
    } catch (error) {
      const cause = search?.error() || error;
      if (
        !budget.blockedUntil &&
        cause instanceof Error &&
        cause.message === "CLICKBUS_VPN_NOT_CONNECTED"
      )
        await closeClickBusBrowser();
      const blocked =
        budget.blockedUntil ||
        (error instanceof Error && error.message === "PROVIDER_BLOCKED");
      return {
        ...empty,
        error: blocked
          ? "PROVIDER_BLOCKED"
          : diagnosticCode(cause, "CLICKBUS_QUERY_FAILED"),
      };
    } finally {
      await search?.close();
    }
  }
  async close() {
    await closeClickBusBrowser();
  }
}
let session: ClickBusBrowserSession | undefined;
export const getClickBusBrowserSession = () =>
  (session ??= new ClickBusBrowserSession());
