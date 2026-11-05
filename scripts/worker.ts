import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
config({ quiet: true });
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { db } from "../lib/server/database";
import { seal } from "../lib/server/crypto";
import { runOneQuery, drainAlerts } from "../lib/monitoring/engine";
import { queryProvider } from "../lib/monitoring/query-provider";
import { claimWorker, releaseWorker } from "../lib/monitoring/lease";
import {
  providerProxyPool,
  closeProviderProxies,
} from "../lib/monitoring/proxy";
import {
  syncWhatsApp,
  sendAlert,
  closeWhatsApp,
  sendVerification,
  sendDiagnosticMessage,
  whatsAppReady,
  checkpointWhatsApp,
} from "../lib/monitoring/whatsapp";
import { runDiagnostic } from "../lib/monitoring/health-checks";
import { runSearchJob } from "../lib/monitoring/manual-search";
import { closeClickBusBrowser } from "../lib/scrapers/clickbus/browser";
const owner = randomUUID();
let stopping = false;
async function main() {
  seal("configuration-check", "startup");
  const proxies = providerProxyPool();
  if (!(await claimWorker(owner)))
    throw new Error("Já existe um worker ativo para este banco.");
  const heartbeat = setInterval(async () => {
    try {
      if (!(await claimWorker(owner))) stopping = true;
    } catch {
      stopping = true;
    }
  }, 10000);
  const shutdown = () => {
    stopping = true;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  console.log(
    "[FastBus] Worker iniciado. Monitoramento persistente e consultas sequenciais.",
  );
  console.log(
    `[FastBus] Transporte HTTP das fontes: ${proxies.size ? `${proxies.size} proxy(s) configurado(s)` : "conexão direta"}.`,
  );
  console.log(
    `[FastBus] ClickBus: ${process.env.CLICKBUS_TRANSPORT === "browser" ? "navegador isolado com Browsec configurado" : "transporte HTTP legado"}.`,
  );
  try {
    while (!stopping) {
      try {
        await syncWhatsApp();
        await sendVerification();
        await runSearchJob(queryProvider);
        await runDiagnostic({
          query: queryProvider,
          ready: whatsAppReady,
          send: sendDiagnosticMessage,
        });
        await drainAlerts(sendAlert);
        await runOneQuery(queryProvider);
        await db()
          .prepare("DELETE FROM limits WHERE reset_at<?")
          .run(Date.now());
        await db()
          .prepare("DELETE FROM outbound_gates WHERE next_at<?")
          .run(Date.now() - 86400000);
        await db()
          .prepare("DELETE FROM sessions WHERE expires_at<?")
          .run(Date.now());
        await db()
          .prepare(
            "UPDATE alerts SET status='expired' WHERE status='pending' AND created_at<?",
          )
          .run(Date.now() - 86400000);
        await db()
          .prepare("DELETE FROM alerts WHERE created_at<?")
          .run(Date.now() - 30 * 86400000);
      } catch {
        console.error(
          "[FastBus] Ciclo interrompido; nova tentativa em 5 segundos.",
        );
      }
      await delay(5000);
    }
  } finally {
    await closeClickBusBrowser();
    await closeProviderProxies();
    if (whatsAppReady()) await checkpointWhatsApp().catch(() => {});
    await closeWhatsApp();
    clearInterval(heartbeat);
    await releaseWorker(owner);
    await db()
      .prepare(
        "UPDATE whatsapp_service SET status='offline',qr=NULL,qr_expires=NULL WHERE desired=1",
      )
      .run();
  }
}
void main().catch((error) => {
  console.error(
    "[FastBus]",
    error instanceof Error ? error.message : "Falha ao iniciar",
  );
  process.exitCode = 1;
});
