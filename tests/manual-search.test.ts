import { test, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { NextRequest } from "next/server";
import { db, closeDatabase } from "../lib/server/db";
import { digest, seal } from "../lib/server/crypto";
import {
  enqueueSearch,
  listSearches,
  runSearchJob,
  finishSearch,
} from "../lib/monitoring/manual-search";
import { today, type MonitorConfig } from "../lib/monitoring/schema";
import type { Query } from "../lib/monitoring/engine";
import * as routes from "../app/api/search/route";

const root = resolve("data", `search-test-${randomUUID()}`);
process.env.FASTBUS_DATA_DIR = root;
process.env.FASTBUS_DATA_KEY = randomBytes(32).toString("hex");
process.env.APP_ORIGIN = "http://localhost:3000";
delete process.env.FASTBUS_CLOUD_MODE;
after(() => {
  closeDatabase();
  if (!root.startsWith(resolve("data") + sep))
    throw new Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
beforeEach(() => {
  db().prepare("DELETE FROM providers").run();
  db().prepare("DELETE FROM search_jobs").run();
});
function fixture() {
  const id = randomUUID(),
    token = randomBytes(32).toString("hex");
  db()
    .prepare(
      "INSERT INTO users(id,email_hash,profile,password,created_at) VALUES (?,?,?,?,?)",
    )
    .run(
      id,
      id,
      seal({ name: "Fixture", email: `${id}@example.com` }, id),
      "unused",
      Date.now(),
    );
  db()
    .prepare("INSERT INTO sessions VALUES (?,?,?)")
    .run(digest(token), id, Date.now() + 60000);
  return { id, token };
}
const config = (): MonitorConfig => ({
  origin: "Rio de Janeiro::RJ",
  destination: "Sao Paulo::SP",
  startDate: today(),
  endDate: today(),
  maxPrice: 150,
  intervalMinutes: 1440,
  benefit: "any",
  providers: ["Guanabara"],
});
const query: Query = async (_, provider) => ({
  result: {
    disponivel: true,
    vagasIdJovem: 0,
    detalhes: "fixture",
    siteUrl:
      provider === "Guanabara"
        ? "https://www.viajeguanabara.com.br/"
        : "https://www.clickbus.com.br/",
    provedor: provider,
    resultados: [],
  },
});
function req(token = "", input?: unknown, origin = "http://localhost:3000") {
  return new NextRequest("http://localhost:3000/api/search", {
    method: input ? "POST" : "GET",
    headers: {
      cookie: `fastbus=${token}`,
      origin,
      ...(input ? { "content-type": "application/json" } : {}),
    },
    body: input ? JSON.stringify(input) : undefined,
  });
}

test("search routes require login, same origin and valid fixed dates, isolate owners and never execute on GET", async () => {
  const a = fixture(),
    b = fixture();
  assert.equal((await routes.GET(req())).status, 401);
  assert.equal(
    (
      await routes.POST(
        req(a.token, { config: config() }, "https://evil.example"),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await routes.POST(
        req(a.token, { config: { ...config(), rollingWindow: 14 } }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await routes.POST(
        req(a.token, { config: { ...config(), providers: ["Gontijo"] } }),
      )
    ).status,
    400,
  );
  const response = await routes.POST(req(a.token, { config: config() }));
  assert.equal(response.status, 202);
  const { id } = await response.json();
  const own = await routes.GET(req(a.token));
  assert.match(own.headers.get("cache-control")!, /no-store/);
  assert.equal((await own.json()).searches[0].state, "queued");
  assert.deepEqual(
    (await (await routes.GET(req(b.token))).json()).searches,
    [],
  );
  await assert.rejects(enqueueSearch(b.id, { id }), /não encontrada/);
  assert.equal(
    (
      db().prepare("SELECT payload FROM search_jobs WHERE id=?").get(id) as any
    ).payload.includes("Rio de Janeiro"),
    false,
  );
});

test("manual search shares source pauses, supports continuation and does not create alerts or advance monitors", async () => {
  const a = fixture();
  const cfg = {
    ...config(),
    endDate: new Date(Date.parse(today()) + 86400000)
      .toISOString()
      .slice(0, 10),
    providers: ["Guanabara", "ClickBus"] as MonitorConfig["providers"],
  };
  const id = await enqueueSearch(a.id, { config: cfg });
  await assert.rejects(enqueueSearch(a.id, { config: cfg }), /andamento/);
  let calls = 0;
  await runSearchJob(async (...args) => {
    calls++;
    return query(...args);
  }, id);
  assert.equal(calls, 2); // one query per provider, next dates respect the durable pause
  let result = (await listSearches(a.id))[0];
  assert.equal(result.state, "partial");
  assert.equal(result.targets.filter((t) => t.state === "pending").length, 2);
  await assert.rejects(enqueueSearch(a.id, { id }), /pausa/);
  db().prepare("UPDATE providers SET next_at=0").run();
  await enqueueSearch(a.id, { id });
  await runSearchJob(query, id);
  result = (await listSearches(a.id))[0];
  assert.equal(result.state, "complete");
  assert.equal(result.targets.filter((t) => t.state === "complete").length, 4);
  await finishSearch(id, "JOB_INTERRUPTED");
  assert.equal((await listSearches(a.id))[0].state, "complete");
  assert.equal(
    (db().prepare("SELECT COUNT(*) n FROM alerts").get() as any).n,
    0,
  );
  assert.equal(
    (db().prepare("SELECT COUNT(*) n FROM monitors").get() as any).n,
    0,
  );
});

test("real prices, safe purchase domains and confirmed benefit seats are required; source failures are visible", async () => {
  const a = fixture();
  const id = await enqueueSearch(a.id, {
    config: {
      ...config(),
      benefit: "id100",
      providers: ["ClickBus", "Guanabara"],
    },
  });
  await runSearchJob(async (cfg, provider, date) => {
    const response = await query(cfg, provider, date);
    if (provider === "Guanabara") throw new Error("PROVIDER_BLOCKED");
    return {
      result: {
        ...response.result,
        resultados: [
          { empresa: "Sem preço" },
          {
            empresa: "Sem vaga",
            valorNumerico: 0,
            tipoGratuidade: "id_jovem_100",
            vagasIdJovem: 0,
          },
          {
            empresa: "Link externo",
            valorNumerico: 0,
            tipoGratuidade: "id_jovem_100",
            vagasIdJovem: 2,
            linkCompra: "https://evil.example",
          },
          {
            empresa: "Confirmada",
            valorNumerico: 0,
            tipoGratuidade: "id_jovem_100",
            vagasIdJovem: 2,
            linkCompra: "https://www.clickbus.com.br/onibus",
          },
          {
            empresa: "Preço inválido",
            valorNumerico: -1,
            tipoGratuidade: "id_jovem_100",
            vagasIdJovem: 2,
          },
        ],
      },
    };
  }, id);
  const job = (await listSearches(a.id))[0];
  assert.deepEqual(
    job.trips.map((t) => t.company),
    ["Confirmada"],
  );
  assert.equal(job.trips[0].price, 0);
  assert.equal(job.targets[1].state, "failed");
  assert.ok(job.targets[1].nextAt! > Date.now());
});

test("a pause acquired after enqueue or lost worker lease prevents calling the source; stale jobs expire and account deletion cascades", async () => {
  const a = fixture();
  const id = await enqueueSearch(a.id, { config: config() });
  db()
    .prepare("INSERT INTO providers(id,next_at) VALUES ('Guanabara',?)")
    .run(Date.now() + 60000);
  let calls = 0;
  const forbidden: Query = async (...args) => {
    calls++;
    return query(...args);
  };
  await runSearchJob(forbidden, id);
  assert.equal(calls, 0);
  db().prepare("UPDATE providers SET next_at=0").run();
  await enqueueSearch(a.id, { id });
  await runSearchJob(forbidden, id, Date.now() + 145000, () => false);
  assert.equal(calls, 0);
  db()
    .prepare("UPDATE search_jobs SET state='running',updated_at=? WHERE id=?")
    .run(Date.now() - 360000, id);
  assert.equal((await listSearches(a.id))[0].code, "JOB_EXPIRED");
  db().prepare("DELETE FROM users WHERE id=?").run(a.id);
  assert.equal(
    (
      db()
        .prepare("SELECT COUNT(*) n FROM search_jobs WHERE id=?")
        .get(id) as any
    ).n,
    0,
  );
});

test("validated partial offers and counts survive encrypted persistence; valid empty stays empty", async () => {
  const { validateProviderResult } =
    await import("../lib/scrapers/result-contract");
  const observed = Date.now();
  const a = fixture();
  const id = await enqueueSearch(a.id, { config: config() });
  await runSearchJob(async (cfg, provider, date) => {
    const response = await query(cfg, provider, date);
    return {
      result: validateProviderResult(
        {
          ...response.result,
          resultados: [
            { empresa: "Válida", valorNumerico: 50 },
            { empresa: "Inválida", valorNumerico: -1 },
          ],
        },
        provider,
        date,
        observed,
      ),
    };
  }, id);
  const saved = (await listSearches(a.id))[0];
  assert.equal(saved.targets[0].code, "PROVIDER_PARTIAL");
  assert.equal(saved.targets[0].validation?.rejected, 1);
  assert.equal(saved.targets[0].validation?.observedAt, observed);
  assert.ok(saved.trips.length > 0);
  assert.equal(saved.trips[0].evidence?.observedAt, observed);
  assert.equal(saved.trips[0].evidence?.quotedMinor, 5000);
  assert.equal(saved.targets[0].outcome, "partial");
  assert.equal(saved.state, "partial");
  db().prepare("DELETE FROM providers").run();
  const emptyId = await enqueueSearch(a.id, { config: config() });
  await runSearchJob(async (cfg, provider, date) => {
    const response = await query(cfg, provider, date);
    return {
      result: validateProviderResult(
        { ...response.result, disponivel: false, resultados: [] },
        provider,
        date,
        observed,
      ),
    };
  }, emptyId);
  const empty = (await listSearches(a.id)).find((job) => job.id === emptyId)!;
  assert.equal(empty.targets[0].code, "PROVIDER_EMPTY");
});

test("manual searches enforce three rounds per account per 15 minutes and discard results after seven days", async () => {
  const a = fixture();
  for (let i = 0; i < 3; i++) {
    db().prepare("DELETE FROM providers").run();
    const id = await enqueueSearch(a.id, { config: config() });
    await runSearchJob(query, id);
  }
  db().prepare("DELETE FROM providers").run();
  await assert.rejects(
    enqueueSearch(a.id, { config: config() }),
    /três rodadas/,
  );
  assert.equal((await listSearches(a.id)).length, 3);
  db()
    .prepare("UPDATE search_jobs SET created_at=? WHERE user_id=?")
    .run(Date.now() - 8 * 86400000, a.id);
  assert.deepEqual(await listSearches(a.id), []);
});
