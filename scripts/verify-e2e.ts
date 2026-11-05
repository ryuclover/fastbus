import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as httpServer, request as httpRequest } from "node:http";
import { createServer as httpsServer } from "node:https";
import { resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";
import { db, closeDatabase } from "../lib/server/db";
import { seal } from "../lib/server/crypto";
import { validateProviderResult } from "../lib/scrapers/result-contract";
import { today } from "../lib/monitoring/schema";
import { runOneQuery, deliverOne } from "../lib/monitoring/engine";
import { sendWithTransport } from "../lib/monitoring/whatsapp";
import { deliverVerification } from "../lib/monitoring/contact-verification";
import { deliverRecovery } from "../lib/monitoring/account-recovery";
import { serviceId } from "../lib/server/whatsapp-service";
import { converterTripsClickBus } from "../lib/scrapers/clickbus/client";
import { parseClickBusTripPage } from "../lib/scrapers/clickbus/benefits";
import { productionTraces, isPrivateBuildFile } from "./build-traces.mjs";

// Real production HTTP/UI/database/worker code; only external providers and delivery are fixtures.
// Never load .env.local into this process or start a worker against the user's database.
const root = resolve("data", `e2e-${randomUUID()}`);
mkdirSync(root, { recursive: true });
process.env.FASTBUS_DATA_DIR = root;
process.env.FASTBUS_DATA_KEY = randomBytes(32).toString("hex");
process.env.FASTBUS_RUNTIME_DIR = resolve(root, "runtime");
process.env.FASTBUS_ALLOW_REGISTRATION = "true";

const openssl =
  process.env.FASTBUS_TEST_OPENSSL ||
  (process.platform === "win32"
    ? "C:/Program Files/Git/usr/bin/openssl.exe"
    : "openssl");
let server: ReturnType<typeof spawn> | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let serverLog = "";
let nextPort = 0;
const proxy = httpsServer();
proxy.on("request", (incoming, outgoing) => {
  const upstream = httpRequest(
    {
      hostname: "127.0.0.1",
      port: nextPort,
      method: incoming.method,
      path: incoming.url,
      headers: incoming.headers,
    },
    (response) => {
      outgoing.writeHead(response.statusCode!, response.headers);
      response.pipe(outgoing);
    },
  );
  upstream.on("error", () => {
    outgoing.writeHead(502);
    outgoing.end();
  });
  incoming.pipe(upstream);
});

async function main() {
  assert.ok(
    existsSync(".next/BUILD_ID"),
    "Execute npm run build antes do E2E.",
  );
  for (const path of productionTraces()) {
    const trace = JSON.parse(readFileSync(path, "utf8"));
    for (const file of trace.files) {
      assert.ok(
        !isPrivateBuildFile(file, path),
        `Arquivo privado no pacote de produção: ${file}`,
      );
    }
  }
  console.log("E2E: manifests de produção não incluem dados privados locais.");
  execFileSync(
    openssl,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-keyout",
      resolve(root, "key.pem"),
      "-out",
      resolve(root, "cert.pem"),
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "ignore", windowsHide: true },
  );
  proxy.setSecureContext({
    key: readFileSync(resolve(root, "key.pem")),
    cert: readFileSync(resolve(root, "cert.pem")),
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  const origin = `https://127.0.0.1:${(proxy.address() as import("node:net").AddressInfo).port}`;
  const reserve = httpServer();
  reserve.listen(0, "127.0.0.1");
  await once(reserve, "listening");
  nextPort = (reserve.address() as import("node:net").AddressInfo).port;
  await new Promise<void>((done) => reserve.close(() => done()));
  server = spawn(
    process.execPath,
    [
      "node_modules/next/dist/bin/next",
      "start",
      "-H",
      "127.0.0.1",
      "-p",
      String(nextPort),
    ],
    {
      env: { ...process.env, NODE_ENV: "production", APP_ORIGIN: origin },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  server.stdout!.on("data", (chunk) => {
    serverLog = (serverLog + chunk).slice(-12000);
  });
  server.stderr!.on("data", (chunk) => {
    serverLog = (serverLog + chunk).slice(-12000);
  });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (server.exitCode !== null)
      throw new Error("Next encerrou antes de iniciar.");
    ready = await fetch(`http://127.0.0.1:${nextPort}/`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ready) break;
    await delay(500);
  }
  assert.ok(ready, "Next não iniciou no prazo.");
  browser = await chromium.launch({
    headless: true,
    ...(process.env.FASTBUS_TEST_CHROME_PATH
      ? { executablePath: process.env.FASTBUS_TEST_CHROME_PATH }
      : {}),
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1060 },
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin
      ? route.continue()
      : route.abort(),
  );
  const email = `e2e-${randomUUID()}@example.com`;
  let password = randomBytes(24).toString("hex");
  const action = async (
    path: string,
    click: () => Promise<unknown>,
    status = 200,
  ) => {
    const response = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === path && r.request().method() !== "GET",
    );
    await click();
    assert.equal((await response).status(), status, path);
  };
  await page.goto(origin);
  await page.getByRole("button", { name: "Criar conta", exact: true }).click();
  await page.getByLabel("Como podemos te chamar?").fill("Pessoa E2E");
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await action("/api/account/register", () =>
    page.getByRole("button", { name: "Criar minha conta" }).click(),
  );
  await page
    .getByRole("button", { name: "Novo monitoramento", exact: true })
    .waitFor();
  const me = await (
    await context.request.get(`${origin}/api/account/me`)
  ).json();
  const userId = me.user.id;
  const cookies = await context.cookies();
  const cookie = cookies.find((c) => c.name === "__Host-fastbus")!;
  assert.ok(cookie?.secure && cookie.httpOnly && cookie.sameSite === "Strict");
  assert.equal(
    (await context.request.get(`${origin}/api/admin/whatsapp`)).status(),
    403,
  );
  assert.equal(
    (
      await context.request.post(`${origin}/api/monitors`, {
        data: {},
        headers: { origin: "https://attacker.example" },
      })
    ).status(),
    403,
  );
  for (const path of ["/api/buscar", "/api/provedor/ClickBus"])
    assert.equal((await context.request.get(origin + path)).status(), 410);
  console.log(
    "E2E: cadastro real, cookie de produção, CSRF e acesso administrativo verificados.",
  );

  await page
    .getByLabel("Número esperando o contato do FastBus")
    .fill("+55 11 99999-9999");
  await page.getByRole("checkbox", { name: /Este número é meu/ }).check();
  await action("/api/whatsapp", () =>
    page.getByRole("button", { name: "Enviar código de confirmação" }).click(),
  );
  await page.getByText("Confirmação pendente", { exact: true }).waitFor();
  db()
    .prepare(
      "INSERT INTO whatsapp_service(id,desired,status,updated_at) VALUES (?,1,'ready',?)",
    )
    .run(serviceId, Date.now());
  let verificationCode = "";
  await deliverVerification({
    getNumberId: async (number) => ({ _serialized: `${number}@c.us` }),
    sendMessage: async (_id, message) => {
      verificationCode = message.match(/Seu código é: (\d{4})/)![1];
      return {};
    },
  });
  await page.getByLabel("Código recebido no WhatsApp").fill(verificationCode);
  await page
    .getByRole("button", { name: "Confirmar número e ativar avisos" })
    .waitFor();
  await action("/api/whatsapp", () =>
    page
      .getByRole("button", { name: "Confirmar número e ativar avisos" })
      .click(),
  );
  await page
    .getByText("Número confirmado. Os avisos estão ativados.")
    .waitFor();
  db().prepare("DELETE FROM outbound_gates").run();
  await page
    .getByRole("button", { name: "Novo monitoramento", exact: true })
    .click();
  await page
    .getByRole("checkbox", { name: "Guanabara", exact: true })
    .uncheck();
  await page.getByRole("checkbox", { name: "ClickBus", exact: true }).check();
  await page
    .locator("select")
    .filter({ has: page.locator('option[value="id100"]') })
    .selectOption("id100");
  const travelDate = new Date(Date.parse(today()) + 86400000)
    .toISOString()
    .slice(0, 10);
  await page.getByLabel("Até", { exact: true }).fill(travelDate);
  await page.getByLabel("De", { exact: true }).fill(travelDate);
  await action(
    "/api/monitors",
    () =>
      page
        .getByRole("button", { name: "Salvar monitoramento", exact: true })
        .click(),
    201,
  );
  await page.getByRole("button", { name: "Pausar rota" }).waitFor();
  const monitorId = (
    await (await context.request.get(`${origin}/api/monitors`)).json()
  ).monitors[0].id;
  await action(`/api/monitors/${monitorId}`, () =>
    page.getByRole("button", { name: "Pausar rota" }).click(),
  );
  assert.equal(
    await runOneQuery(async () => {
      throw new Error("Paused query ran");
    }),
    false,
  );
  await action(`/api/monitors/${monitorId}`, () =>
    page.getByRole("button", { name: "Retomar rota" }).click(),
  );
  await page.getByRole("button", { name: "Editar rota" }).click();
  await page.getByLabel("Preço máximo (R$)").fill("120");
  await action(`/api/monitors/${monitorId}`, () =>
    page
      .getByRole("button", { name: "Salvar monitoramento", exact: true })
      .click(),
  );
  await page.getByRole("button", { name: "Pausar rota" }).waitFor();

  // Reuse a sanitized observation, adjusting its travel date to keep this test evergreen.
  const fixture = JSON.parse(
    readFileSync("tests/fixtures/clickbus/2026-11-18-online.json", "utf8"),
  );
  fixture.searchTrip.parts[0].departure.date = travelDate;
  fixture.searchTrip.parts[0].arrival.date = travelDate;
  const quotas = parseClickBusTripPage(
    JSON.stringify({ trips: [fixture.pageTrip] }),
    fixture.tripId,
  );
  const query = async () => ({
    result: validateProviderResult(
      {
        disponivel: true,
        vagasIdJovem: 4,
        detalhes: "Fixture observada",
        siteUrl: "https://www.clickbus.com.br/",
        provedor: "ClickBus",
        resultados: (
          await converterTripsClickBus(
            [fixture.searchTrip],
            "Rio de Janeiro",
            "RJ",
            "Sao Paulo",
            "SP",
            travelDate,
            "https://www.clickbus.com.br/",
            true,
            async () => quotas,
          )
        ).resultados,
      },
      "ClickBus",
      travelDate,
      Date.now(),
      fixture.route,
    ),
  });
  assert.equal(await runOneQuery(query), true);
  assert.equal(
    (db().prepare("SELECT COUNT(*) AS n FROM alerts").get() as { n: number }).n,
    1,
  );
  db().prepare("UPDATE providers SET next_at=0").run();
  db().prepare("UPDATE monitors SET next_at=0").run();
  await runOneQuery(query);
  assert.equal(
    (db().prepare("SELECT COUNT(*) AS n FROM alerts").get() as { n: number }).n,
    1,
    "Duplicate alert",
  );
  db()
    .prepare(
      "INSERT INTO whatsapp_service(id,desired,status,updated_at) VALUES (?,1,'ready',?) ON CONFLICT(id) DO UPDATE SET desired=1,status='ready'",
    )
    .run(serviceId, Date.now());
  let deliveries = 0;
  await deliverOne((id, payload) =>
    sendWithTransport(
      {
        async getNumberId(number) {
          assert.equal(number, "5511999999999");
          return { _serialized: `${number}@c.us` };
        },
        async sendMessage(recipient, message) {
          assert.equal(recipient, "5511999999999@c.us");
          assert.match(message, /ID Jovem 100%/);
          assert.match(message, /Taxas e valor final/);
          deliveries++;
        },
      },
      id,
      payload,
    ),
  );
  assert.equal(deliveries, 1);
  await page.reload();
  await page.getByRole("button", { name: "Alertas", exact: true }).click();
  await page.getByText("Enviado no WhatsApp", { exact: true }).waitFor();
  assert.match(
    (await page
      .getByRole("link", { name: "Conferir na fonte" })
      .getAttribute("href")) || "",
    /clickbus\.com\.br\/viagem\?tripId=/,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  console.log(
    "E2E: contato, criar/pausar/retomar/editar rota, cotas observadas → fila → destinatário → confirmação e histórico; deduplicação e mobile verificados.",
  );

  // Admin UI reads a QR fixture through the real, permission-checked backend.
  db()
    .prepare(
      "INSERT INTO leases(id,owner,expires_at) VALUES ('worker','e2e-fixture',?)",
    )
    .run(Date.now() + 120000);
  db().prepare("UPDATE users SET role='admin' WHERE id=?").run(userId);
  const qr = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>').toString("base64")}`;
  db()
    .prepare(
      "UPDATE whatsapp_service SET status='qr',qr=?,qr_expires=? WHERE id=?",
    )
    .run(seal(qr, serviceId), Date.now() + 60000, serviceId);
  await page.goto(`${origin}/admin`);
  await page
    .getByAltText("QR Code administrativo do WhatsApp FastBus")
    .waitFor();
  await action("/api/admin/whatsapp", () =>
    page.getByRole("button", { name: "Desconectar número do FastBus" }).click(),
  );
  assert.equal(
    (
      db().prepare("SELECT desired FROM whatsapp_service").get() as {
        desired: number;
      }
    ).desired,
    0,
  );
  await page.goto(origin);
  await page.getByRole("button", { name: "Conta", exact: true }).click();
  await page.getByLabel("Senha atual", { exact: true }).fill(password);
  const newPassword = randomBytes(24).toString("hex");
  await page.getByLabel("Nova senha", { exact: true }).fill(newPassword);
  await action("/api/account/password", () =>
    page.getByRole("button", { name: "Atualizar senha" }).click(),
  );
  password = newPassword;
  await page.getByRole("button", { name: "Entrar no FastBus" }).waitFor();
  assert.equal(
    (await context.request.get(`${origin}/api/monitors`)).status(),
    401,
  );
  await page
    .getByRole("button", { name: "Esqueci minha senha", exact: true })
    .click();
  await page.getByLabel("E-mail da conta", { exact: true }).fill(email);
  await action("/api/account/recovery", () =>
    page
      .getByRole("button", {
        name: "Enviar código de recuperação",
        exact: true,
      })
      .click(),
  );
  db().prepare("UPDATE whatsapp_service SET desired=1,status='ready'").run();
  db().prepare("DELETE FROM outbound_gates").run();
  let recoveryCode = "";
  assert.equal(
    await deliverRecovery({
      getNumberId: async (number) => ({ _serialized: `${number}@c.us` }),
      sendMessage: async (_id, message) => {
        recoveryCode = message.match(/recuperação é: (\d{8})/)![1];
      },
    }),
    true,
  );
  db()
    .prepare("UPDATE whatsapp_service SET desired=0,status='disconnected'")
    .run();
  await page
    .getByLabel("Código de recuperação", { exact: true })
    .fill(recoveryCode);
  const recoveredPassword = randomBytes(24).toString("hex");
  await page
    .getByLabel("Nova senha de acesso", { exact: true })
    .fill(recoveredPassword);
  await action("/api/account/recovery", () =>
    page
      .getByRole("button", { name: "Definir nova senha", exact: true })
      .click(),
  );
  await page
    .getByText("Senha alterada. Entre com sua nova senha.", { exact: true })
    .waitFor();
  password = recoveredPassword;
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Senha", { exact: true }).fill(password);
  await action("/api/account/login", () =>
    page.getByRole("button", { name: "Entrar no FastBus" }).click(),
  );
  await page.getByRole("button", { name: "Conta", exact: true }).click();
  await page.getByLabel("Confirme sua senha", { exact: true }).fill(password);
  await page
    .getByRole("checkbox", { name: "Entendo que a exclusão é permanente." })
    .check();
  await action("/api/account/delete", () =>
    page.getByRole("button", { name: "Excluir conta e dados" }).click(),
  );
  await page.getByRole("button", { name: "Entrar no FastBus" }).waitFor();
  for (const table of [
    "users",
    "sessions",
    "monitors",
    "alerts",
    "notification_contacts",
  ])
    assert.equal(
      (
        db().prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
          n: number;
        }
      ).n,
      0,
      table,
    );
  assert.deepEqual(errors, []);
  console.log(
    "E2E: QR administrativo, desconexão, troca de senha, revogação, novo login e exclusão em cascata verificados. Nenhum provedor ou WhatsApp real foi acessado.",
  );
}

async function verify() {
  try {
    await main();
  } catch (error) {
    mkdirSync("test-results", { recursive: true });
    writeFileSync("test-results/e2e-server.log", serverLog);
    await browser
      ?.contexts()[0]
      ?.pages()[0]
      ?.screenshot({ path: "test-results/e2e-failure.png", fullPage: true })
      .catch(() => {});
    throw error;
  } finally {
    await browser?.close();
    if (server && server.exitCode === null) {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    }
    proxy.closeAllConnections();
    if (proxy.listening)
      await new Promise<void>((done) => proxy.close(() => done()));
    closeDatabase();
    if (!root.startsWith(resolve("data") + sep))
      throw new Error("Unsafe cleanup path");
    rmSync(root, { recursive: true, force: true, maxRetries: 3 });
  }
}
void verify().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
