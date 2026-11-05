import { chromium } from "playwright";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";

const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.WHATSAPP_CHROME_PATH ||
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1060 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
let loggedIn = false;
let adminConnectionFailed = true;
let monitors = [];
const diagnosticJobs = [];
let destination = {
  phone: "",
  enabled: false,
  senderReady: true,
  workerOnline: true,
};
const user = {
  id: "ui-test",
  name: "Gabriel Demo",
  email: "demo@example.com",
  role: "user",
  mustChangePassword: false,
};
const now = Date.now();
const date = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo",
}).format(new Date());
await page.route("**/api/**", async (route) => {
  const request = route.request();
  const path = new URL(request.url()).pathname;
  const method = request.method();
  let result = { ok: true };
  if (path === "/api/admin/diagnostics") {
    if (method === "POST") {
      const input = request.postDataJSON();
      assert.ok(["whatsapp", "message", "provider"].includes(input.kind));
      assert.equal(input.phone, undefined);
      diagnosticJobs.unshift({
        id: `fixture-${diagnosticJobs.length}`,
        kind: input.kind,
        state: "passed",
        code:
          input.kind === "whatsapp"
            ? "WHATSAPP_READY"
            : input.kind === "message"
              ? "MESSAGE_SENT"
              : "PROVIDER_OK",
        offers: input.kind === "provider" ? 2 : null,
        created_at: Date.now(),
        completed_at: Date.now(),
      });
      result = { id: diagnosticJobs[0].id, state: "queued" };
    } else
      result = {
        checkedAt: Date.now(),
        database: true,
        cloud: false,
        cloudConfigured: false,
        sender: {
          status: "ready",
          sessionStored: true,
          workerOnline: true,
          desired: true,
        },
        contact: { enabled: true, verified: true },
        queue: [],
        monitors: [
          {
            id: "00000000-0000-4000-8000-000000000002",
            label: "Rio de Janeiro / RJ → São Paulo / SP",
            providers: ["ClickBus"],
            date,
          },
        ],
        providers: [
          {
            id: "ClickBus",
            nextAt: 0,
            lastCode: "CLICKBUS_TRIPS_RESPONSE_TIMEOUT",
            lastAt: now,
            commercial: true,
            youth: true,
          },
        ],
        jobs: diagnosticJobs,
      };
  }
  if (path === "/api/account/me") result = { user: loggedIn ? user : null };
  if (path === "/api/account/register" || path === "/api/account/login")
    loggedIn = true;
  if (path === "/api/account/logout") loggedIn = false;
  if (path === "/api/whatsapp") {
    if (method === "POST") {
      const input = request.postDataJSON();
      destination = {
        ...destination,
        phone: input.phone.replace(/[ ()-]/g, ""),
        enabled: false,
        verified: false,
        verificationStatus: "sent",
      };
    }
    if (method === "PATCH") {
      assert.equal(request.postDataJSON().code, "1234");
      destination = {
        ...destination,
        enabled: true,
        verified: true,
        verificationStatus: "verified",
      };
    }
    if (method === "DELETE")
      destination = { ...destination, phone: "", enabled: false };
    result =
      method === "POST"
        ? { verificationRequired: true, senderReady: true }
        : destination;
  }
  if (path === "/api/admin/whatsapp" && method === "POST") {
    assert.equal(request.postDataJSON().retry, true);
    assert.equal(request.postDataJSON().password, undefined);
    adminConnectionFailed = false;
  }
  if (path === "/api/admin/whatsapp")
    result = {
      status: adminConnectionFailed ? "error" : "qr",
      desired: true,
      workerOnline: true,
      error: adminConnectionFailed
        ? "O WhatsApp Web recarregou durante a conexão. Tente gerar o QR Code novamente."
        : null,
      retryAt: adminConnectionFailed ? Date.now() + 300000 : null,
      qr: adminConnectionFailed
        ? null
        : `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="280" height="280"><rect width="280" height="280" fill="white"/><rect x="15" y="15" width="250" height="250" rx="12" fill="none" stroke="#1d6551" stroke-width="4"/><text x="140" y="135" text-anchor="middle" font-size="20" fill="#1d6551">QR DE TESTE</text><text x="140" y="165" text-anchor="middle" font-size="13" fill="#687773">apenas demonstração visual</text></svg>').toString("base64")}`,
    };
  if (path === "/api/alerts")
    result = {
      alerts: [
        {
          id: "alert-test",
          origin: "Rio de Janeiro::RJ",
          destination: "Sao Paulo::SP",
          date,
          departure: "12:00",
          company: "Empresa de demonstração",
          provider: "Guanabara",
          price: 89.9,
          benefit: "nenhuma",
          url: "https://viajeguanabara.com.br",
          observedAt: now,
          createdAt: now,
          status: "pending",
        },
      ],
    };
  if (path === "/api/monitors") {
    if (method === "POST")
      monitors.push({
        ...request.postDataJSON(),
        id: "monitor-test",
        active: true,
        status: "Aguardando primeira consulta",
        checkedAt: null,
        nextAt: now + 3600000,
      });
    result = method === "GET" ? { monitors } : { id: "monitor-test" };
  }
  if (path.startsWith("/api/monitors/")) {
    if (method === "PATCH") monitors[0].active = request.postDataJSON().active;
    if (method === "PUT")
      monitors[0] = { ...monitors[0], ...request.postDataJSON() };
  }
  await route.fulfill({
    status: method === "POST" && path === "/api/monitors" ? 201 : 200,
    contentType: "application/json",
    body: JSON.stringify(result),
  });
});
async function verifyDiagnostics() {
  await page.getByRole("heading", { name: "Está tudo funcionando?" }).waitFor();
  for (const [button, code] of [
    ["Verificar conexão", "WHATSAPP_READY"],
    ["Enviar mensagem de teste", "MESSAGE_SENT"],
    ["Testar buscador", "PROVIDER_OK"],
  ]) {
    await page.getByRole("button", { name: button, exact: true }).click();
    await page.getByText(new RegExp(` · ${code}`)).waitFor();
  }
  assert.equal(diagnosticJobs.length, 3);
}
if (process.env.FASTBUS_UI_ADMIN_ONLY === "true") {
  loggedIn = true;
  user.role = "admin";
  try {
    await page.goto(
      (process.env.FASTBUS_TEST_URL || "http://127.0.0.1:3000") + "/admin",
      { waitUntil: "networkidle" },
    );
    await page
      .getByRole("button", { name: "Tentar conexão novamente" })
      .waitFor({ timeout: 15000 });
    await page
      .getByRole("button", { name: "Tentar conexão novamente" })
      .click();
    await page
      .getByAltText("QR Code administrativo do WhatsApp FastBus")
      .waitFor({ timeout: 15000 });
    assert.equal(adminConnectionFailed, false);
    await verifyDiagnostics();
    assert.deepEqual(errors, []);
    console.log(
      "Admin verificado: falha visível, nova tentativa sem senha repetida e QR exibido. APIs simuladas.",
    );
  } finally {
    await browser.close();
  }
  process.exit(0);
}
try {
  await mkdir("docs/screenshots", { recursive: true });
  await page.goto(process.env.FASTBUS_TEST_URL || "http://127.0.0.1:3000", {
    waitUntil: "networkidle",
  });
  await page.getByRole("button", { name: "Entrar no FastBus" }).waitFor();
  await page.screenshot({
    path: "docs/screenshots/fastbus-home.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Criar conta", exact: true }).click();
  await page.getByLabel("Como podemos te chamar?").fill("Gabriel Demo");
  await page.getByLabel("E-mail", { exact: true }).fill("demo@example.com");
  await page.getByLabel("Senha", { exact: true }).fill("somente-demo-123456");
  await page
    .getByRole("button", { name: "Criar minha conta", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Novo monitoramento", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Salvar monitoramento", exact: true })
    .click();
  await page.getByRole("button", { name: "Pausar rota" }).waitFor();
  await page
    .getByLabel("Número esperando o contato do FastBus")
    .fill("+55 11 99999-9999");
  await page.getByRole("checkbox", { name: /Este número é meu/ }).check();
  await page
    .getByRole("button", { name: "Enviar código de confirmação" })
    .click();
  await page.getByLabel("Código recebido no WhatsApp").fill("1234");
  await page
    .getByRole("button", { name: "Confirmar número e ativar avisos" })
    .click();
  await page
    .getByText("Número confirmado. Os avisos estão ativados.")
    .waitFor();
  assert.equal(destination.enabled, true);
  assert.equal(
    await page
      .getByRole("button", { name: "Gerar QR Code do FastBus" })
      .count(),
    0,
  );
  await page.screenshot({
    path: "docs/screenshots/fastbus-dashboard.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Pausar rota" }).click();
  await page.getByRole("button", { name: "Retomar rota" }).waitFor();
  await page.getByRole("button", { name: "Editar rota" }).click();
  await page.getByLabel("Preço máximo (R$)").fill("120");
  await page
    .getByRole("button", { name: "Salvar monitoramento", exact: true })
    .click();
  assert.equal(monitors[0].maxPrice, 120);
  await page.getByRole("button", { name: "Alertas", exact: true }).click();
  await page.getByRole("link", { name: "Conferir na fonte" }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page
    .getByRole("button", { name: "Monitoramentos", exact: true })
    .click();
  await page.screenshot({
    path: "docs/screenshots/fastbus-mobile.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "Mobile layout overflows",
  );
  await page.setViewportSize({ width: 1440, height: 1060 });
  await page.goto(
    (process.env.FASTBUS_TEST_URL || "http://127.0.0.1:3000") + "/admin",
  );
  await page.getByRole("heading", { name: "Acesso restrito." }).waitFor();
  assert.equal(
    await page
      .getByAltText("QR Code administrativo do WhatsApp FastBus")
      .count(),
    0,
  );
  user.role = "admin";
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByRole("button", { name: "Tentar conexão novamente" })
    .waitFor();
  await page.getByRole("button", { name: "Tentar conexão novamente" }).click();
  await page
    .getByAltText("QR Code administrativo do WhatsApp FastBus")
    .waitFor();
  await verifyDiagnostics();
  await page.screenshot({
    path: "docs/screenshots/fastbus-admin.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({
    path: "docs/screenshots/fastbus-admin-mobile.png",
    fullPage: true,
  });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  assert.deepEqual(errors, []);
  console.log(
    "UI verificada: cadastro, criação, pausa, edição, alertas e mobile. API simulada; nenhum WhatsApp ou provedor foi acessado.",
  );
} catch (error) {
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/ui-failure.png",
    fullPage: true,
  });
  console.error(
    "UI fixture diagnostic:",
    await page
      .locator(".fb-whatsapp")
      .textContent({ timeout: 1000 })
      .catch(() => ""),
    errors,
  );
  throw error;
} finally {
  await browser.close();
}
