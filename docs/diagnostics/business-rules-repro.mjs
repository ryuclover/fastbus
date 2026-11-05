// Read-only audit of production code, using an isolated disposable database and fake transports.
// Run: node --import tsx docs/diagnostics/business-rules-repro.mjs
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve, sep } from "node:path";

const root = resolve("data", `business-review-${randomUUID()}`);
process.env.FASTBUS_DATA_DIR = root;
process.env.FASTBUS_DATA_KEY = randomBytes(32).toString("hex");
delete process.env.TURSO_DATABASE_URL;
delete process.env.TURSO_AUTH_TOKEN;
delete process.env.VERCEL;
delete process.env.FASTBUS_CLOUD_MODE;
const { db, closeDatabase } = await import("../../lib/server/db.ts");
const { seal } = await import("../../lib/server/crypto.ts");
const { today, monitorSchema } = await import("../../lib/monitoring/schema.ts");
const { recordResult, deliverOne, runOneQuery } =
  await import("../../lib/monitoring/engine.ts");
const { enqueueSearch, runSearchJob, listSearches } =
  await import("../../lib/monitoring/manual-search.ts");
const { freeBrowserEgress } =
  await import("../../lib/monitoring/free-egress.ts");
const { fetchGuanabaraDirect } =
  await import("../../lib/scrapers/guanabara/client.ts");
const config = {
  origin: "Rio de Janeiro::RJ",
  destination: "Sao Paulo::SP",
  startDate: today(),
  endDate: today(),
  maxPrice: 150,
  intervalMinutes: 1440,
  benefit: "any",
  providers: ["Guanabara"],
};
const result = (price = 0, departure = "23:59") => ({
  disponivel: true,
  vagasIdJovem: 2,
  detalhes: "audit fixture",
  siteUrl: "https://viajeguanabara.com.br/",
  provedor: "Guanabara",
  resultados: [
    {
      empresa: "Fixture",
      horario: departure,
      classe: "Convencional",
      valorNumerico: price,
      tipoGratuidade: "id_jovem_100",
      vagasIdJovem: 2,
    },
  ],
});
function fixture(overrides = {}) {
  db().prepare("DELETE FROM users").run();
  db().prepare("DELETE FROM providers").run();
  const configuration = { ...config, ...overrides };
  const id = randomUUID(),
    monitor = randomUUID(),
    encrypted = seal(configuration, monitor);
  db()
    .prepare(
      "INSERT INTO users(id,email_hash,profile,password,created_at) VALUES (?,?,?,?,?)",
    )
    .run(
      id,
      id,
      seal({ name: "Audit fixture", email: "fixture@example.com" }, id),
      "unused",
      Date.now(),
    );
  db()
    .prepare(
      "INSERT INTO monitors(id,user_id,config,next_at,created_at) VALUES (?,?,?,?,?)",
    )
    .run(monitor, id, encrypted, 0, Date.now());
  return { user: id, row: { id: monitor, user_id: id, config: encrypted } };
}
const findings = {};
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
try {
  let f = fixture();
  assert.equal(
    await recordResult(f.row, config, "Guanabara", today(), result()),
    true,
  );
  db()
    .prepare("UPDATE alerts SET status='expired' WHERE monitor_id=?")
    .run(f.row.id);
  const retry = await recordResult(
    f.row,
    config,
    "Guanabara",
    today(),
    result(),
  );
  assert.equal(retry, false);
  findings.undelivered_offer_suppressed = {
    firstAlert: "expired, never sent",
    sameOfferCreatedAgain: retry,
  };

  f = fixture();
  Date.now = () => Date.parse(`${today()}T23:30:00-03:00`);
  await recordResult(f.row, config, "Guanabara", today(), result(100, "00:01"));
  let sent = 0;
  await deliverOne(async () => {
    sent++;
    return true;
  });
  assert.equal(sent, 1);
  findings.departure_time_not_checked = {
    simulatedNow: "23:30 America/Sao_Paulo",
    departureSameDay: "00:01",
    fakeTransportCalls: sent,
  };
  Date.now = originalNow;

  f = fixture();
  await recordResult(f.row, config, "Guanabara", today(), result(80));
  let accepted = 0;
  await deliverOne(async () => {
    accepted++;
    throw new Error("SEND_UNCONFIRMED");
  });
  db().prepare("UPDATE alerts SET next_at=0 WHERE monitor_id=?").run(f.row.id);
  await deliverOne(async () => {
    accepted++;
    return true;
  });
  assert.equal(accepted, 2);
  findings.ambiguous_send_retried = {
    acceptedByFakeTransport: accepted,
    finalStatus: db()
      .prepare("SELECT status FROM alerts WHERE monitor_id=?")
      .get(f.row.id).status,
  };

  const intra = monitorSchema.safeParse({
    ...config,
    destination: "Niteroi::RJ",
    benefit: "id100",
  });
  assert.equal(intra.success, true);
  findings.intrastate_id_jovem_accepted = intra.success;

  const anchor = Date.parse(`${today()}T12:00:00Z`);
  const countries = [0, 1, 2].map(
    (day) => freeBrowserEgress(anchor + day * 86400000, true).code,
  );
  assert.equal(new Set(countries).size, 1);
  findings.daily_vpn_country_repeats = {
    countriesOnThreeConsecutiveDaysAtSameTime: countries,
  };

  f = fixture();
  let id = await enqueueSearch(f.user, { config });
  await runSearchJob(
    async () => ({
      result: {
        ...result(),
        disponivel: false,
        resultados: [],
        error: "PROVIDER_BLOCKED",
      },
    }),
    id,
  );
  let job = (await listSearches(f.user))[0];
  assert.equal(job.state, "complete");
  findings.failed_search_marked_complete = {
    jobState: job.state,
    summaryCode: job.code,
    sourceState: job.targets[0].state,
  };

  f = fixture();
  id = await enqueueSearch(f.user, { config });
  await runSearchJob(
    async () => ({
      result: {
        ...result(),
        disponivel: false,
        resultados: [],
        vagasIdJovem: 0,
      },
    }),
    id,
  );
  job = (await listSearches(f.user))[0];
  assert.equal(job.targets[0].code, "PROVIDER_PARTIAL");
  findings.valid_empty_response_marked_partial = job.targets[0].code;

  globalThis.fetch = async (input) =>
    String(input).includes("/seats/maps/")
      ? Response.json({
          passengerTypeAvailability: [
            { name: "100%", available_seats: 2 },
            { name: "50%", available_seats: 2 },
          ],
        })
      : Response.json({
          trips: [
            {
              trip_id: 1,
              company: "Fixture",
              fare: 100,
              total: 100,
              class_of_service: "Convencional",
            },
          ],
        });
  const fares = await fetchGuanabaraDirect(
    "Rio de Janeiro",
    "RJ",
    "Sao Paulo",
    "SP",
    today(),
    true,
  );
  assert.equal(fares.resultados[0]?.tipoGratuidade, "id_jovem_100");
  findings.positive_fare_mislabeled_free = {
    sourceFare: 100,
    sourceTotal: 100,
    subTotalAndBoardingFee: "absent",
    emittedBenefit: fares.resultados[0].tipoGratuidade,
  };

  f = fixture({ providers: ["ClickBus", "Guanabara"] });
  db()
    .prepare("INSERT INTO providers(id,next_at) VALUES ('ClickBus',?)")
    .run(Date.now() + 3600000);
  let queries = 0;
  const ran = await runOneQuery(async () => {
    queries++;
    return { result: result(80) };
  });
  assert.equal(ran, false);
  assert.equal(queries, 0);
  findings.paused_source_blocks_healthy_alternative = {
    paused: "ClickBus",
    availableAlternative: "Guanabara",
    providerCalls: queries,
    monitorDeferred: true,
  };

  console.log(
    JSON.stringify({ networkRequests: 0, realMessages: 0, findings }, null, 2),
  );
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  closeDatabase();
  if (!root.startsWith(resolve("data") + sep))
    throw new Error("Unsafe audit cleanup");
  rmSync(root, { recursive: true, force: true });
}
