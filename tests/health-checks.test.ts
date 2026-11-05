import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { NextRequest } from "next/server";
import { db, closeDatabase } from "../lib/server/db";
import { digest, seal } from "../lib/server/crypto";
import { serviceId } from "../lib/server/whatsapp-service";
import {
  diagnosticsStatus,
  enqueueDiagnostic,
  runDiagnostic,
} from "../lib/monitoring/health-checks";
import {
  sendTestWithTransport,
  sendWithTransport,
} from "../lib/monitoring/whatsapp";
import { today, type MonitorConfig } from "../lib/monitoring/schema";
import type { Query } from "../lib/monitoring/engine";
import * as routes from "../app/api/admin/diagnostics/route";

const root = resolve("data", `health-test-${randomUUID()}`);
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
const query: Query = async () => ({
  result: {
    disponivel: true,
    vagasIdJovem: 0,
    detalhes: "fixture",
    siteUrl: "https://www.clickbus.com.br/",
    provedor: "ClickBus",
    resultados: [],
  },
});
const deps = { query, ready: () => true, send: async () => true };
function fixture(role = "admin", verified = true) {
  const id = randomUUID(),
    token = randomBytes(32).toString("hex"),
    monitorId = randomUUID();
  db()
    .prepare(
      "INSERT INTO users(id,email_hash,profile,password,created_at,role) VALUES (?,?,?,?,?,?)",
    )
    .run(
      id,
      id,
      seal({ name: "Fixture", email: `${id}@example.com` }, id),
      "unused",
      Date.now(),
      role,
    );
  db()
    .prepare("INSERT INTO sessions VALUES (?,?,?)")
    .run(digest(token), id, Date.now() + 60000);
  const phone = seal("+5521999999999", `contact:${id}`);
  db()
    .prepare("INSERT INTO notification_contacts VALUES (?,?,1,?,?)")
    .run(id, phone, Date.now(), Date.now());
  if (verified)
    db()
      .prepare(
        "INSERT INTO contact_verifications(user_id,id,phone,status,expires_at,created_at) VALUES (?,?,?,'verified',?,?)",
      )
      .run(id, randomUUID(), phone, Date.now() + 60000, Date.now());
  const config: MonitorConfig = {
    origin: "Rio de Janeiro::RJ",
    destination: "Sao Paulo::SP",
    startDate: today(),
    endDate: today(),
    maxPrice: 100,
    intervalMinutes: 1440,
    benefit: "any",
    providers: ["ClickBus"],
  };
  db()
    .prepare(
      "INSERT INTO monitors(id,user_id,config,next_at,created_at) VALUES (?,?,?,?,?)",
    )
    .run(monitorId, id, seal(config, monitorId), Date.now(), Date.now());
  db()
    .prepare(
      "INSERT INTO whatsapp_service(id,desired,status,backup,updated_at) VALUES (?,1,'sleeping','fixture',?) ON CONFLICT(id) DO UPDATE SET desired=1,backup='fixture'",
    )
    .run(serviceId, Date.now());
  return { id, token, monitorId };
}
function req(token = "", input?: unknown, origin = "http://localhost:3000") {
  return new NextRequest("http://localhost:3000/api/admin/diagnostics", {
    method: input ? "POST" : "GET",
    headers: {
      cookie: `fastbus=${token}`,
      origin,
      ...(input ? { "content-type": "application/json" } : {}),
    },
    body: input ? JSON.stringify(input) : undefined,
  });
}
function job(id: string) {
  return db().prepare("SELECT * FROM diagnostic_jobs WHERE id=?").get(id) as {
    state: string;
    code: string;
    payload: string;
  };
}
test("diagnostic routes enforce admin, changed password, origin and strict schema; GET does not run jobs", async () => {
  const user = fixture("user"),
    admin = fixture();
  assert.equal((await routes.GET(req())).status, 401);
  assert.equal((await routes.GET(req(user.token))).status, 403);
  assert.equal(
    (
      await routes.POST(
        req(admin.token, { kind: "whatsapp" }, "https://evil.example"),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await routes.POST(
        req(admin.token, { kind: "message", phone: "+5521999999999" }),
      )
    ).status,
    400,
  );
  db()
    .prepare("UPDATE users SET must_change_password=1 WHERE id=?")
    .run(admin.id);
  assert.equal((await routes.GET(req(admin.token))).status, 403);
  db()
    .prepare("UPDATE users SET must_change_password=0 WHERE id=?")
    .run(admin.id);
  const response = await routes.POST(req(admin.token, { kind: "whatsapp" }));
  assert.equal(response.status, 202);
  const { id } = await response.json();
  const status = await routes.GET(req(admin.token));
  assert.equal(status.status, 200);
  assert.match(status.headers.get("cache-control")!, /no-store/);
  const body = await status.json();
  assert.equal(body.sender.sessionStored, true);
  assert.equal(job(id).state, "queued");
  assert.equal(JSON.stringify(body).includes("payload"), false);
  assert.equal(JSON.stringify(body).includes("+5521"), false);
});
test("provider checks isolate owners, encrypt criteria, share cooldown/backoff and never generate alerts", async () => {
  db().prepare("DELETE FROM providers").run();
  const user = fixture(),
    other = fixture();
  await assert.rejects(
    enqueueDiagnostic(other.id, "provider", user.monitorId, "ClickBus"),
    /monitoramento ativo/,
  );
  const id = await enqueueDiagnostic(
    user.id,
    "provider",
    user.monitorId,
    "ClickBus",
  );
  assert.equal(job(id).payload.includes("Rio de Janeiro"), false);
  let calls = 0;
  await runDiagnostic(
    {
      ...deps,
      query: async () => {
        calls++;
        return {
          result: {
            ...(await query({} as MonitorConfig, "ClickBus", today())).result,
            error: "PROVIDER_BLOCKED",
          },
          blockedUntil: Date.now() + 3600000,
        };
      },
    },
    id,
  );
  assert.equal(calls, 1);
  assert.equal(job(id).code, "PROVIDER_BLOCKED");
  const gate = db()
    .prepare("SELECT next_at,failures FROM providers WHERE id='ClickBus'")
    .get() as { next_at: number; failures: number };
  assert.ok(gate.next_at >= Date.now() + 3590000);
  assert.equal(gate.failures, 1);
  assert.equal(
    (db().prepare("SELECT COUNT(*) AS n FROM alerts").get() as any).n,
    0,
  );
  await assert.rejects(
    enqueueDiagnostic(other.id, "provider", other.monitorId, "ClickBus"),
    /pausa/,
  );
});
test("a source becoming paused after enqueue is not called, and changed monitors are rejected", async () => {
  db().prepare("DELETE FROM providers").run();
  const user = fixture();
  const id = await enqueueDiagnostic(
    user.id,
    "provider",
    user.monitorId,
    "ClickBus",
  );
  db()
    .prepare("INSERT INTO providers VALUES ('ClickBus',?,0)")
    .run(Date.now() + 60000);
  await runDiagnostic(
    {
      ...deps,
      query: async () => {
        throw new Error("must not call");
      },
    },
    id,
  );
  assert.equal(job(id).code, "PROVIDER_COOLDOWN");
  db().prepare("DELETE FROM providers").run();
  const second = await enqueueDiagnostic(
    user.id,
    "provider",
    user.monitorId,
    "ClickBus",
  );
  db().prepare("UPDATE monitors SET active=0 WHERE id=?").run(user.monitorId);
  await runDiagnostic(deps, second);
  assert.equal(job(second).code, "MONITOR_CHANGED");
});
test("live connection checks wait for readiness, reject revoked admins and do not invent success for stale jobs", async () => {
  const user = fixture();
  const id = await enqueueDiagnostic(user.id, "whatsapp");
  assert.equal(await runDiagnostic({ ...deps, ready: () => false }, id), false);
  assert.equal(job(id).state, "queued");
  await assert.rejects(enqueueDiagnostic(user.id, "message"), /andamento/);
  await runDiagnostic(deps, id);
  assert.equal(job(id).code, "WHATSAPP_READY");
  const second = await enqueueDiagnostic(user.id, "whatsapp");
  db().prepare("UPDATE users SET role='user' WHERE id=?").run(user.id);
  await runDiagnostic(deps, second);
  assert.equal(job(second).code, "ADMIN_REQUIRED");
  const other = fixture(),
    old = await enqueueDiagnostic(other.id, "whatsapp");
  db()
    .prepare("UPDATE diagnostic_jobs SET created_at=? WHERE id=?")
    .run(Date.now() - 6 * 60000, old);
  assert.equal((await diagnosticsStatus(other.id)).jobs[0].code, "JOB_EXPIRED");
  assert.equal(await runDiagnostic(deps, old), false);
  assert.equal(job(old).state, "inconclusive");
});
test("message checks require verified contacts and never retry an ambiguous delivery", async () => {
  const unverified = fixture("admin", false);
  await assert.rejects(enqueueDiagnostic(unverified.id, "message"), /Confirme/);
  const user = fixture(),
    id = await enqueueDiagnostic(user.id, "message");
  let sends = 0;
  await runDiagnostic(
    {
      ...deps,
      send: async () => {
        sends++;
        throw new Error("secret phone or token");
      },
    },
    id,
  );
  assert.equal(job(id).state, "inconclusive");
  assert.equal(job(id).code, "CHECK_FAILED");
  await runDiagnostic(deps, id);
  assert.equal(sends, 1);
  const second = await enqueueDiagnostic(user.id, "message");
  db()
    .prepare("UPDATE notification_contacts SET enabled=0 WHERE user_id=?")
    .run(user.id);
  await runDiagnostic(
    {
      ...deps,
      send: async () => {
        sends++;
        return true;
      },
    },
    second,
  );
  assert.equal(job(second).code, "CONTACT_NOT_VERIFIED");
  assert.equal(sends, 1);
});
test("test messages use fixed copy, recheck consent after lookup and share outbound limits with alerts", async () => {
  db().prepare("DELETE FROM outbound_gates").run();
  const user = fixture();
  let sent = "";
  const transport = {
    getNumberId: async () => ({ _serialized: "5521999999999@c.us" }),
    sendMessage: async (_id: string, text: string) => {
      sent = text;
    },
  };
  assert.equal(
    await sendTestWithTransport(transport, user.id, "test-reference"),
    true,
  );
  assert.match(sent, /teste de envio/);
  assert.match(sent, /Não é uma oferta/);
  assert.match(sent, /test-reference/);
  assert.equal(
    await sendWithTransport(transport, user.id, {
      origin: "A",
      destination: "B",
      date: today(),
      departure: "12:00",
      company: "Fixture",
      provider: "ClickBus",
      price: 1,
      benefit: "nenhuma",
      url: "https://www.clickbus.com.br/",
      observedAt: Date.now(),
    }),
    false,
  );
  db().prepare("DELETE FROM outbound_gates").run();
  sent = "";
  assert.equal(
    await sendTestWithTransport(
      {
        ...transport,
        getNumberId: async () => {
          db()
            .prepare(
              "UPDATE notification_contacts SET enabled=0 WHERE user_id=?",
            )
            .run(user.id);
          return { _serialized: "5521999999999@c.us" };
        },
      },
      user.id,
      "second",
    ),
    false,
  );
  assert.equal(sent, "");
});
test("diagnostics limit repeated requests and keep inconclusive provider results distinct from failures", async () => {
  const user = fixture();
  for (let i = 0; i < 3; i++) {
    const id = await enqueueDiagnostic(user.id, "whatsapp");
    await runDiagnostic(deps, id);
  }
  await assert.rejects(
    enqueueDiagnostic(user.id, "whatsapp"),
    /três verificações/,
  );
  const other = fixture();
  for (const [error, limited, expected] of [
    ["ID_JOVEM_UNCONFIRMED", false, "ID_JOVEM_UNCONFIRMED"],
    [undefined, true, "PROVIDER_PARTIAL"],
  ] as const) {
    db().prepare("DELETE FROM providers").run();
    const id = await enqueueDiagnostic(
      other.id,
      "provider",
      other.monitorId,
      "ClickBus",
    );
    await runDiagnostic(
      {
        ...deps,
        query: async (...args) => ({
          ...(await query(...args)),
          limited,
          result: { ...(await query(...args)).result, error },
        }),
      },
      id,
    );
    assert.equal(job(id).state, "inconclusive");
    assert.equal(job(id).code, expected);
    assert.equal(
      (
        db()
          .prepare("SELECT failures FROM providers WHERE id='ClickBus'")
          .get() as any
      ).failures,
      0,
    );
  }
});
