import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { NextRequest } from "next/server";
import { db, closeDatabase, rateLimit } from "../lib/server/db";
import { seal, unseal, digest } from "../lib/server/crypto";
import {
  monitorSchema,
  today,
  type MonitorConfig,
  type MonitorRow,
} from "../lib/monitoring/schema";
import {
  recordResult,
  runOneQuery,
  deliverOne,
  DeliveryUncertain,
  safePurchaseUrl,
  targetFor,
  type AlertPayload,
} from "../lib/monitoring/engine";
import {
  monitoredFetch,
  withRequestBudget,
} from "../lib/monitoring/request-budget";
import * as account from "../app/api/account/[action]/route";
import * as monitors from "../app/api/monitors/route";
import * as monitor from "../app/api/monitors/[id]/route";
import * as whatsapp from "../app/api/whatsapp/route";
import * as alerts from "../app/api/alerts/route";
import type { ScraperResult } from "../lib/scrapers/types";
const testRoot = resolve("data", `test-${randomUUID()}`);
mkdirSync(testRoot, { recursive: true });
process.env.FASTBUS_DATA_DIR = testRoot;
process.env.FASTBUS_DATA_KEY = randomBytes(32).toString("hex");
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.FASTBUS_ALLOW_REGISTRATION = "true";
after(() => {
  closeDatabase();
  if (!testRoot.startsWith(resolve("data") + sep))
    throw new Error("Unsafe cleanup path");
  rmSync(testRoot, { recursive: true, force: true });
});
const cfg = (): MonitorConfig => ({
  origin: "Rio de Janeiro::RJ",
  destination: "Sao Paulo::SP",
  startDate: today(),
  endDate: today(),
  maxPrice: 150,
  intervalMinutes: 60,
  benefit: "any",
  providers: ["Guanabara"],
});
function request(
  path: string,
  method = "GET",
  input?: unknown,
  cookie?: string,
  origin = "http://localhost:3000",
) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: {
      origin,
      ...(cookie ? { cookie } : {}),
      ...(input ? { "Content-Type": "application/json" } : {}),
    },
    body: input ? JSON.stringify(input) : undefined,
  });
}
const context = (action: string) => ({ params: Promise.resolve({ action }) });
const idContext = (id: string) => ({ params: Promise.resolve({ id }) });
let sequence = 0;
async function register() {
  const email = `test${++sequence}@example.com`;
  const response = await account.POST(
    request("/api/account/register", "POST", {
      name: "Pessoa Teste",
      email,
      password: "uma-senha-forte-2026",
    }),
    context("register"),
  );
  assert.equal(
    response.status,
    200,
    JSON.stringify(await response.clone().json()),
  );
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const me = await account.GET(
    request("/api/account/me", "GET", undefined, cookie),
    context("me"),
  );
  const { user } = await me.json();
  return { cookie, user, email };
}
async function create(cookie: string) {
  const response = await monitors.POST(
    request("/api/monitors", "POST", cfg(), cookie),
  );
  assert.equal(response.status, 201);
  return (await response.json()).id as string;
}
function result(price = 100): ScraperResult {
  return {
    disponivel: true,
    vagasIdJovem: 0,
    detalhes: "",
    siteUrl: "https://viajeguanabara.com.br/onibus/teste",
    provedor: "Guanabara",
    resultados: [
      {
        empresa: "Empresa Teste",
        horario: "12:00",
        departureAt: Date.now() + 3600000,
        classe: "Convencional",
        valorNumerico: price,
        linkCompra: "https://viajeguanabara.com.br/onibus/teste",
      },
    ],
  };
}
test("encryption rejects tampering and moving ciphertext between owners", () => {
  const encrypted = seal({ name: "Privado" }, "owner-a");
  assert.ok(!encrypted.includes("Privado"));
  assert.deepEqual(unseal(encrypted, "owner-a"), { name: "Privado" });
  assert.throws(() => unseal(encrypted, "owner-b"));
  const modified = Buffer.from(encrypted, "base64");
  modified[29] ^= 1;
  assert.throws(() => unseal(modified.toString("base64"), "owner-a"));
});
test("invalid dates, reversed/same cities, huge intervals and untrusted providers are rejected", () => {
  assert.ok(monitorSchema.safeParse(cfg()).success);
  for (const value of [
    { startDate: "2026-02-30" },
    { endDate: "2099-01-01" },
    { destination: cfg().origin },
    { origin: "invalid" },
    { intervalMinutes: 1 },
    { providers: ["attacker"] },
    { benefit: "id100", providers: ["Buser"] },
  ]) {
    assert.equal(
      monitorSchema.safeParse({ ...cfg(), ...value }).success,
      false,
    );
  }
});
test("registration encrypts PII, hashes passwords/tokens and sets HttpOnly Strict cookie", async () => {
  const { cookie, user, email } = await register();
  const row = db().prepare("SELECT * FROM users WHERE id=?").get(user.id) as {
    profile: string;
    password: string;
    email_hash: string;
  };
  assert.ok(!row.profile.includes(email));
  assert.ok(!row.password.includes("uma-senha-forte"));
  const stored = db()
    .prepare("SELECT hash FROM sessions WHERE user_id=?")
    .get(user.id) as {
    hash: string;
  };
  assert.equal(stored.hash, digest(cookie.split("=")[1]));
  const login = await account.POST(
    request("/api/account/login", "POST", {
      email,
      password: "uma-senha-forte-2026",
    }),
    context("login"),
  );
  assert.match(login.headers.get("set-cookie")!, /HttpOnly/i);
  assert.match(login.headers.get("set-cookie")!, /SameSite=strict/i);
});
test("unauthenticated access and cross-origin writes are rejected", async () => {
  assert.equal((await monitors.GET(request("/api/monitors"))).status, 401);
  assert.equal(
    (
      await account.POST(
        request(
          "/api/account/register",
          "POST",
          { email: "x@y.com", password: "uma-senha-forte-2026", name: "Teste" },
          undefined,
          "https://attacker.example",
        ),
        context("register"),
      )
    ).status,
    403,
  );
});
test("user B cannot list, edit, delete, pause or read user A monitor and QR", async () => {
  const a = await register();
  const b = await register();
  const id = await create(a.cookie);
  const list = await monitors.GET(
    request("/api/monitors", "GET", undefined, b.cookie),
  );
  assert.deepEqual((await list.json()).monitors, []);
  assert.equal(
    (
      await monitor.PATCH(
        request("/api/monitors/id", "PATCH", { active: false }, b.cookie),
        idContext(id),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await monitor.PUT(
        request("/api/monitors/id", "PUT", cfg(), b.cookie),
        idContext(id),
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await monitor.DELETE(
        request("/api/monitors/id", "DELETE", undefined, b.cookie),
        idContext(id),
      )
    ).status,
    404,
  );
  db()
    .prepare(
      "INSERT INTO whatsapp(user_id,desired,status,qr,qr_expires,updated_at) VALUES (?,1,'qr',?,?,?)",
    )
    .run(
      a.user.id,
      seal("private-qr", a.user.id),
      Date.now() + 60000,
      Date.now(),
    );
  const qr = await whatsapp.GET(
    request("/api/whatsapp", "GET", undefined, b.cookie),
  );
  assert.equal("qr" in (await qr.json()), false);
  db().prepare("DELETE FROM users WHERE id IN (?,?)").run(a.user.id, b.user.id);
});
test("password change revokes all sessions; old password fails and new password works", async () => {
  const a = await register();
  const change = await account.POST(
    request(
      "/api/account/password",
      "POST",
      {
        password: "uma-senha-forte-2026",
        newPassword: "nova-senha-forte-2026",
      },
      a.cookie,
    ),
    context("password"),
  );
  assert.equal(change.status, 200);
  const me = await account.GET(
    request("/api/account/me", "GET", undefined, a.cookie),
    context("me"),
  );
  assert.equal((await me.json()).user, null);
  assert.equal(
    (
      await account.POST(
        request("/api/account/login", "POST", {
          email: a.email,
          password: "uma-senha-forte-2026",
        }),
        context("login"),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await account.POST(
        request("/api/account/login", "POST", {
          email: a.email,
          password: "nova-senha-forte-2026",
        }),
        context("login"),
      )
    ).status,
    200,
  );
});
test("durable rate limits reject excess attempts", () => {
  assert.ok(rateLimit("test-limit", 2, 60000));
  assert.ok(rateLimit("test-limit", 2, 60000));
  assert.equal(rateLimit("test-limit", 2, 60000), false);
});
test("matching queues one alert, suppresses repeats, accepts meaningful price drops", async () => {
  const a = await register();
  const id = await create(a.cookie);
  const row = db()
    .prepare("SELECT * FROM monitors WHERE id=?")
    .get(id) as MonitorRow;
  assert.equal(
    await recordResult(row, cfg(), "Guanabara", today(), result()),
    true,
  );
  assert.equal(
    await recordResult(row, cfg(), "Guanabara", today(), result()),
    false,
  );
  assert.equal(
    await recordResult(row, cfg(), "Guanabara", today(), result(99)),
    false,
  );
  assert.equal(
    await recordResult(row, cfg(), "Guanabara", today(), result(90)),
    true,
  );
  const b = await register();
  assert.deepEqual(
    (
      await (
        await alerts.GET(request("/api/alerts", "GET", undefined, b.cookie))
      ).json()
    ).alerts,
    [],
  );
  assert.equal(
    (
      await (
        await alerts.GET(request("/api/alerts", "GET", undefined, a.cookie))
      ).json()
    ).alerts.length,
    2,
  );
  db().prepare("DELETE FROM users WHERE id IN (?,?)").run(a.user.id, b.user.id);
});
test("unavailable responses, unknown price, false gratuity and unsafe links do not alert", async () => {
  const a = await register();
  const id = await create(a.cookie);
  const row = db()
    .prepare("SELECT * FROM monitors WHERE id=?")
    .get(id) as MonitorRow;
  assert.equal(
    await recordResult(row, cfg(), "Guanabara", today(), {
      ...result(),
      error: "BLOCKED",
    }),
    false,
  );
  assert.equal(
    await recordResult(row, cfg(), "Guanabara", today(), {
      ...result(),
      disponivel: false,
    }),
    false,
  );
  assert.equal(
    await recordResult(
      row,
      { ...cfg(), benefit: "id100" },
      "Guanabara",
      today(),
      result(0),
    ),
    false,
  );
  assert.equal(
    safePurchaseUrl(
      "https://viajeguanabara.com.br.attacker.test/a",
      "Guanabara",
    ),
    null,
  );
  assert.equal(safePurchaseUrl("javascript:alert(1)", "Guanabara"), null);
  assert.equal(
    safePurchaseUrl("http://viajeguanabara.com.br/a", "Guanabara"),
    null,
  );
  assert.equal(
    safePurchaseUrl("https://user:pass@viajeguanabara.com.br/a", "Guanabara"),
    null,
  );
  db().prepare("DELETE FROM users WHERE id=?").run(a.user.id);
});
test("editing criteria cancels pending alerts and rejects results from in-flight old queries", async () => {
  const a = await register();
  const id = await create(a.cookie);
  const row = db()
    .prepare("SELECT * FROM monitors WHERE id=?")
    .get(id) as MonitorRow;
  await recordResult(row, cfg(), "Guanabara", today(), result());
  assert.equal(
    (
      await monitor.PUT(
        request(
          "/api/monitors/id",
          "PUT",
          { ...cfg(), maxPrice: 80 },
          a.cookie,
        ),
        idContext(id),
      )
    ).status,
    200,
  );
  assert.equal(
    await recordResult(row, cfg(), "Guanabara", today(), result(70)),
    false,
  );
  assert.equal(
    (
      db().prepare("SELECT status FROM alerts WHERE monitor_id=?").get(id) as {
        status: string;
      }
    ).status,
    "cancelled",
  );
  db().prepare("DELETE FROM users WHERE id=?").run(a.user.id);
});
test("worker resumes saved progress, serializes provider access and schedules backoff", async () => {
  db().prepare("DELETE FROM monitors").run();
  db().prepare("DELETE FROM providers").run();
  const a = await register();
  const first = await create(a.cookie);
  await create(a.cookie);
  let calls = 0;
  await runOneQuery(async () => {
    calls++;
    return {
      result: { ...result(), disponivel: false, resultados: [] },
      blockedUntil: Date.now() + 3600000,
    };
  });
  await runOneQuery(async () => {
    calls++;
    return { result: result() };
  });
  assert.equal(calls, 1);
  const provider = db()
    .prepare("SELECT * FROM providers WHERE id='Guanabara'")
    .get() as {
    next_at: number;
    failures: number;
  };
  assert.ok(provider.next_at > Date.now() + 3500000);
  assert.equal(provider.failures, 1);
  const cursors = db()
    .prepare("SELECT SUM(cursor) AS total FROM monitors WHERE user_id=?")
    .get(a.user.id) as {
    total: number;
  };
  assert.equal(cursors.total, 1);
  assert.ok(targetFor(cfg(), 12)?.date === today());
  assert.ok(db().prepare("SELECT next_at FROM monitors WHERE id=?").get(first));
  const alternate = { ...cfg(), providers: ["Guanabara", "ClickBus"] };
  db()
    .prepare("UPDATE monitors SET cursor=0,next_at=0,config=? WHERE id=?")
    .run(seal(alternate, first), first);
  let selected = "";
  await runOneQuery(async (_config, provider) => {
    selected = provider;
    return { result: { ...result(), resultados: [] } };
  });
  assert.equal(selected, "ClickBus");
  db().prepare("DELETE FROM users WHERE id=?").run(a.user.id);
});
test("offline WhatsApp keeps alerts pending, send failure retries, success marks delivered", async () => {
  db().prepare("DELETE FROM monitors").run();
  const a = await register();
  const id = await create(a.cookie);
  const row = db()
    .prepare("SELECT * FROM monitors WHERE id=?")
    .get(id) as MonitorRow;
  await recordResult(row, cfg(), "Guanabara", today(), result());
  await deliverOne(async () => false);
  let alert = db()
    .prepare("SELECT * FROM alerts WHERE monitor_id=?")
    .get(id) as {
    id: string;
    status: string;
    attempts: number;
  };
  assert.equal(alert.status, "pending");
  assert.equal(alert.attempts, 0);
  db().prepare("UPDATE alerts SET next_at=0 WHERE id=?").run(alert.id);
  await deliverOne(async () => {
    throw new Error("network");
  });
  alert = db()
    .prepare("SELECT * FROM alerts WHERE id=?")
    .get(alert.id) as typeof alert;
  assert.equal(alert.attempts, 1);
  assert.equal(alert.status, "pending");
  db().prepare("UPDATE alerts SET next_at=0 WHERE id=?").run(alert.id);
  await deliverOne(async (owner, payload) => {
    assert.equal(owner, a.user.id);
    assert.equal(payload.price, 100);
    return true;
  });
  assert.equal(
    (
      db().prepare("SELECT status FROM alerts WHERE id=?").get(alert.id) as {
        status: string;
      }
    ).status,
    "sent",
  );
  db().prepare("DELETE FROM users WHERE id=?").run(a.user.id);
});
test("a concurrent or restarted worker cannot repeat an uncertain alert", async () => {
  const a = await register();
  const id = await create(a.cookie);
  const row = db()
    .prepare("SELECT * FROM monitors WHERE id=?")
    .get(id) as MonitorRow;
  await recordResult(row, cfg(), "Guanabara", today(), result());
  const status = () =>
    (
      db().prepare("SELECT status FROM alerts WHERE monitor_id=?").get(id) as {
        status: string;
      }
    ).status;
  await deliverOne(async () => {
    assert.equal(status(), "in_flight");
    assert.equal(
      await deliverOne(async () => assert.fail("duplicate dispatch")),
      false,
    );
    throw new DeliveryUncertain();
  });
  assert.equal(status(), "uncertain");
  db()
    .prepare(
      "UPDATE alerts SET status='in_flight',next_at=0 WHERE monitor_id=?",
    )
    .run(id);
  assert.equal(await deliverOne(async () => assert.fail("blind retry")), false);
  assert.equal(status(), "uncertain");
  db().prepare("DELETE FROM users WHERE id=?").run(a.user.id);
});
test("old alerts expire without sending; pause prevents delivery", async () => {
  const a = await register();
  const id = await create(a.cookie);
  const row = db()
    .prepare("SELECT * FROM monitors WHERE id=?")
    .get(id) as MonitorRow;
  await recordResult(row, cfg(), "Guanabara", today(), result());
  const alert = db()
    .prepare("SELECT id,payload FROM alerts WHERE monitor_id=?")
    .get(id) as {
    id: string;
    payload: string;
  };
  const payload = unseal<AlertPayload>(alert.payload, alert.id);
  db().prepare("UPDATE monitors SET active=0 WHERE id=?").run(id);
  await deliverOne(async () => {
    assert.fail("Paused monitor sent a message");
  });
  db().prepare("UPDATE monitors SET active=1 WHERE id=?").run(id);
  db()
    .prepare("UPDATE alerts SET payload=? WHERE id=?")
    .run(
      seal({ ...payload, observedAt: Date.now() - 25 * 3600000 }, alert.id),
      alert.id,
    );
  await deliverOne(async () => {
    assert.fail("Expired alert sent a message");
  });
  assert.equal(
    (
      db().prepare("SELECT status FROM alerts WHERE id=?").get(alert.id) as {
        status: string;
      }
    ).status,
    "expired",
  );
  db().prepare("DELETE FROM users WHERE id=?").run(a.user.id);
});
test("account deletion requires password and cascades monitors, alerts, QR and sessions", async () => {
  const a = await register();
  const id = await create(a.cookie);
  const row = db()
    .prepare("SELECT * FROM monitors WHERE id=?")
    .get(id) as MonitorRow;
  await recordResult(row, cfg(), "Guanabara", today(), result());
  await whatsapp.POST(
    request(
      "/api/whatsapp",
      "POST",
      { phone: "+5511999999999", enabled: true, consent: true },
      a.cookie,
    ),
  );
  assert.equal(
    (
      await account.POST(
        request("/api/account/delete", "POST", { password: "wrong" }, a.cookie),
        context("delete"),
      )
    ).status,
    401,
  );
  assert.equal(
    (
      await account.POST(
        request(
          "/api/account/delete",
          "POST",
          { password: "uma-senha-forte-2026" },
          a.cookie,
        ),
        context("delete"),
      )
    ).status,
    200,
  );
  for (const table of [
    "monitors",
    "alerts",
    "notification_contacts",
    "sessions",
  ])
    assert.equal(
      (
        db()
          .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE user_id=?`)
          .get(a.user.id) as {
          count: number;
        }
      ).count,
      0,
    );
});
test("HTTP budget stops immediately on 429 and respects Retry-After without fallback calls", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("blocked", {
      status: 429,
      headers: { "retry-after": "3600" },
    });
  };
  try {
    const { budget } = await withRequestBudget(async () => {
      await assert.rejects(monitoredFetch("https://example.com"));
      await assert.rejects(monitoredFetch("https://example.com"));
      return null;
    });
    assert.equal(calls, 1);
    assert.ok(budget.blockedUntil > Date.now() + 3500000);
  } finally {
    globalThis.fetch = original;
  }
});
