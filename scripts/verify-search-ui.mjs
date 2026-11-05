import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.WHATSAPP_CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const base = process.env.FASTBUS_TEST_URL || "http://127.0.0.1:3107";
let loggedIn = true,
  searches = [],
  saved = null,
  calls = 0;
const user = {
  id: "search-ui-fixture",
  name: "Demo",
  email: "demo@example.com",
  role: "user",
  mustChangePassword: false,
};
await page.route("**/api/**", async (route) => {
  const request = route.request(),
    path = new URL(request.url()).pathname;
  let result = { ok: true };
  if (path === "/api/account/me") result = { user: loggedIn ? user : null };
  else if (path === "/api/account/login") loggedIn = true;
  else if (path === "/api/search") {
    if (request.method() === "POST") {
      calls++;
      const input = request.postDataJSON();
      assert.equal(input.config.origin, "Rio de Janeiro::RJ");
      const date = input.config.startDate;
      searches = [
        {
          id: "fixture-job",
          config: input.config,
          state: "partial",
          code: "SEARCH_PARTIAL",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          targets: [
            {
              provider: "Guanabara",
              date,
              state: "complete",
              code: "PROVIDER_OK",
            },
            {
              provider: "ClickBus",
              date,
              state: "pending",
              nextAt: Date.now() + 600000,
            },
          ],
          trips: [
            {
              id: "one",
              provider: "Guanabara",
              date,
              company: "Empresa Aurora",
              departure: "08:00",
              arrival: "14:00",
              duration: "6h",
              cabin: "Executivo",
              price: 79.9,
              benefit: "nenhuma",
              seats: 0,
              url: "https://www.viajeguanabara.com.br/",
            },
            {
              id: "two",
              provider: "Guanabara",
              date,
              company: "Empresa Brisa",
              departure: "22:00",
              arrival: "06:00",
              duration: "8h",
              cabin: "Leito",
              price: 110,
              benefit: "nenhuma",
              seats: 0,
              url: "https://www.viajeguanabara.com.br/",
            },
          ],
        },
      ];
      result = { id: "fixture-job" };
    } else result = { searches };
  } else if (path === "/api/monitors") {
    if (request.method() === "POST") saved = request.postDataJSON();
    result = { monitors: [] };
  } else if (path === "/api/alerts") result = { alerts: [] };
  else if (path === "/api/whatsapp")
    result = {
      phone: "",
      enabled: false,
      senderReady: false,
      workerOnline: false,
    };
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(result),
  });
});
try {
  await mkdir("docs/screenshots", { recursive: true });
  await page.goto(base + "/buscar");
  await page
    .getByRole("button", { name: "Buscar passagens", exact: true })
    .waitFor();
  await page.getByLabel("Preço máximo (R$)").fill("140");
  await page
    .getByRole("button", { name: "Buscar passagens", exact: true })
    .click();
  await page.locator(".fs-trip").getByText("Empresa Aurora", { exact: true }).waitFor();
  assert.equal(await page.locator(".fs-trip").count(), 2);
  assert.equal(
    await page.getByRole("button", { name: "Continuar busca" }).isDisabled(),
    true,
  );
  await page
    .getByLabel("Empresa", { exact: true })
    .selectOption("Empresa Aurora");
  assert.equal(await page.locator(".fs-trip").count(), 1);
  await page.getByLabel("Empresa", { exact: true }).selectOption("");
  await page.getByLabel("Saída", { exact: true }).selectOption("3");
  assert.equal(await page.locator(".fs-trip").count(), 1);
  await page.locator(".fs-trip").getByText("Empresa Brisa", { exact: true }).waitFor();
  await page.getByLabel("Saída", { exact: true }).selectOption("");
  await page
    .getByText("Ver situação das fontes e datas", { exact: true })
    .click();
  await page.getByText(/Em pausa até/).waitFor();
  await page.screenshot({
    path: "docs/screenshots/fastbus-search.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({
    path: "docs/screenshots/fastbus-search-mobile.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Criar alerta desta busca" }).click();
  await page
    .getByText("Revise os critérios da sua busca e salve para criar o alerta.")
    .waitFor();
  assert.equal(
    await page.locator('input[type="number"]').first().inputValue(),
    "140",
  );
  assert.equal(saved, null); // saving a search opens the review form without creating a monitor
  assert.equal(calls, 1); // viewing results or opening alert form cannot query providers
  await page.setViewportSize({ width: 1440, height: 1060 });
  await page.screenshot({
    path: "docs/screenshots/fastbus-search-alert-draft.png",
    fullPage: true,
  });
  // Logged-out criteria survive the login round trip.
  loggedIn = false;
  searches = [];
  await page.goto(base + "/buscar");
  await page.getByRole("button", { name: "Entrar para buscar" }).waitFor();
  await page
    .getByLabel("Destino", { exact: true })
    .selectOption("Curitiba::PR");
  await page.getByRole("button", { name: "Entrar para buscar" }).click();
  await page.getByLabel("E-mail", { exact: true }).fill("demo@example.com");
  await page.getByLabel("Senha", { exact: true }).fill("fixture-password-only");
  await page
    .locator("form")
    .getByRole("button", { name: "Entrar no FastBus", exact: true })
    .click();
  await page.waitForURL("**/buscar");
  await page
    .getByRole("button", { name: "Buscar passagens", exact: true })
    .waitFor();
  assert.equal(
    await page.getByLabel("Destino", { exact: true }).inputValue(),
    "Curitiba::PR",
  );
  assert.equal(calls, 1);
  assert.deepEqual(errors, []);
  console.log(
    "Busca manual verificada em desktop/mobile: resultados, filtros, pausas, revisão do alerta e preservação após login. APIs simuladas; nenhum envio ou consulta real.",
  );
} finally {
  await browser.close();
}
