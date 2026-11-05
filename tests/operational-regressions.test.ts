import { test, after } from "node:test";
import { runOneQuery } from "../lib/monitoring/engine";
import { diagnosticCode } from "../lib/monitoring/diagnostics";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { resolve, sep } from "node:path";
import { rmSync } from "node:fs";
import { db, closeDatabase } from "../lib/server/db";
import { seal, emailIndex, verifyPassword } from "../lib/server/crypto";
import {
  drainAlerts,
  targetFor,
  type AlertPayload,
} from "../lib/monitoring/engine";
import {
  today,
  monitorSchema,
  type MonitorConfig,
} from "../lib/monitoring/schema";
import {
  requestRecovery,
  resetPassword,
  deliverRecovery,
} from "../lib/monitoring/account-recovery";
import { serviceId } from "../lib/server/whatsapp-service";
const root = resolve("data", `operational-test-${randomUUID()}`);
process.env.FASTBUS_DATA_DIR = root;
process.env.FASTBUS_DATA_KEY = randomBytes(32).toString("hex");
after(() => {
  closeDatabase();
  if (!root.startsWith(resolve("data") + sep))
    throw new Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
const config: MonitorConfig = {
  origin: "Rio de Janeiro::RJ",
  destination: "Salvador::BA",
  startDate: today(),
  endDate: today(),
  rollingWindow: 14,
  maxPrice: 100,
  intervalMinutes: 1440,
  benefit: "id100",
  providers: ["ClickBus"],
};
function fixture(verified = true) {
  const id = randomUUID(),
    email = `${id}@example.com`,
    phone = seal("+5521999999999", `contact:${id}`);
  db()
    .prepare(
      "INSERT INTO users(id,email_hash,profile,password,created_at) VALUES (?,?,?,?,?)",
    )
    .run(
      id,
      emailIndex(email),
      seal({ name: "Fixture", email }, id),
      "unused",
      Date.now(),
    );
  db()
    .prepare("INSERT INTO notification_contacts VALUES (?,?,1,?,?)")
    .run(id, phone, Date.now(), Date.now());
  if (verified)
    db()
      .prepare(
        "INSERT INTO contact_verifications(user_id,id,phone,status,expires_at,created_at) VALUES (?,?,?,'verified',?,?)",
      )
      .run(id, randomUUID(), phone, Date.now() + 600000, Date.now());
  const monitor = randomUUID();
  db()
    .prepare(
      "INSERT INTO monitors(id,user_id,config,next_at,created_at) VALUES (?,?,?,?,?)",
    )
    .run(monitor, id, seal(config, monitor), Date.now(), Date.now());
  return { id, email, monitor };
}
function alert(user: ReturnType<typeof fixture>, age = 0) {
  const id = randomUUID(),
    now = Date.now() - age;
  const payload: AlertPayload = {
    origin: config.origin,
    destination: config.destination,
    date: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    departure: "12:00",
    company: "Fixture",
    provider: "ClickBus",
    price: 0,
    benefit: "nenhuma",
    url: "https://www.clickbus.com.br/",
    observedAt: now,
  };
  db()
    .prepare(
      "INSERT INTO alerts(id,user_id,monitor_id,payload,next_at,created_at) VALUES (?,?,?,?,?,?)",
    )
    .run(id, user.id, user.monitor, seal(payload, id), now, now);
  return id;
}
test("an expired alert does not consume the send opportunity of a fresh verified recipient", async () => {
  const user = fixture();
  const old = alert(user, 25 * 3600000),
    fresh = alert(user);
  let sent = 0;
  await drainAlerts(
    async () => {
      sent++;
      return true;
    },
    Date.now() + 2000,
    1,
  );
  assert.equal(sent, 1);
  assert.equal(
    (db().prepare("SELECT status FROM alerts WHERE id=?").get(old) as any)
      .status,
    "expired",
  );
  assert.equal(
    (db().prepare("SELECT status FROM alerts WHERE id=?").get(fresh) as any)
      .status,
    "sent",
  );
});
test("an unverified recipient cannot starve another verified user's alert", async () => {
  const blocked = fixture(false),
    eligible = fixture();
  const pending = alert(blocked, 1000);
  const fresh = alert(eligible);
  let owner = "";
  await drainAlerts(
    async (id) => {
      owner = id;
      return true;
    },
    Date.now() + 2000,
    1,
  );
  assert.equal(owner, eligible.id);
  assert.equal(
    (db().prepare("SELECT status FROM alerts WHERE id=?").get(pending) as any)
      .status,
    "pending",
  );
  assert.equal(
    (db().prepare("SELECT status FROM alerts WHERE id=?").get(fresh) as any)
      .status,
    "sent",
  );
});
test("advancing the calendar and cursor does not skip alternating departures", (t) => {
  const base = Date.UTC(2026, 9, 30, 15);
  t.mock.timers.enable({ apis: ["Date"], now: base });
  try {
    const cfg = { ...config, startDate: "2026-10-30", endDate: "2026-11-12" };
    for (let i = 0; i < 28; i++) {
      t.mock.timers.setTime(base + i * 86400000);
      assert.equal(targetFor(cfg, i)!.date, today());
    }
  } finally {
    t.mock.timers.reset();
  }
});
test("unsupported source/benefit combinations are rejected before saving", () => {
  for (const providers of [["Gontijo"], ["AguiaBranca"], ["Buser"]])
    assert.equal(
      monitorSchema.safeParse({ ...config, providers }).success,
      false,
    );
  assert.equal(
    monitorSchema.safeParse({
      ...config,
      benefit: "any",
      providers: ["AguiaBranca"],
    }).success,
    true,
  );
});
test("password recovery requires a verified contact and revokes sessions after one-time confirmation", async () => {
  const user = fixture();
  db()
    .prepare("INSERT INTO sessions VALUES (?,?,?)")
    .run("fixture-session", user.id, Date.now() + 600000);
  db()
    .prepare(
      "INSERT INTO whatsapp_service(id,desired,status,updated_at) VALUES (?,1,'ready',?) ON CONFLICT(id) DO UPDATE SET desired=1",
    )
    .run(serviceId, Date.now());
  db().prepare("DELETE FROM outbound_gates").run();
  assert.equal(await requestRecovery(`${randomUUID()}@example.com`), false);
  assert.equal(await requestRecovery(fixture(false).email), false);
  assert.equal(await requestRecovery(user.email), true);
  await assert.rejects(
    resetPassword(user.email, "00000000", "long-new-password"),
  );
  let code = "";
  assert.equal(
    await deliverRecovery({
      getNumberId: async (number) => ({ _serialized: `${number}@c.us` }),
      sendMessage: async (_id, message) => {
        code = message.match(/recuperação é: (\d{8})/)![1];
      },
    }),
    true,
  );
  await resetPassword(user.email, code, "long-new-password");
  assert.equal(
    await verifyPassword(
      "long-new-password",
      (
        db()
          .prepare("SELECT password FROM users WHERE id=?")
          .get(user.id) as any
      ).password,
    ),
    true,
  );
  assert.equal(
    (
      db()
        .prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id=?")
        .get(user.id) as any
    ).n,
    0,
  );
  await assert.rejects(resetPassword(user.email, code, "another-password"));
});
test("unconfirmed youth quota is a completed lookup, not a technical provider failure", async () => {
  db().prepare("UPDATE monitors SET active=0").run();
  const user = fixture();
  db().prepare("DELETE FROM providers").run();
  await runOneQuery(async () => ({
    result: {
      disponivel: false,
      vagasIdJovem: 0,
      detalhes: "Cota não confirmada",
      siteUrl: "https://www.clickbus.com.br/",
      provedor: "ClickBus",
      resultados: [],
      error: "ID_JOVEM_UNCONFIRMED",
    },
  }));
  assert.equal(
    (
      db()
        .prepare("SELECT failures FROM providers WHERE id='ClickBus'")
        .get() as any
    ).failures,
    0,
  );
  assert.equal(
    (
      db()
        .prepare("SELECT code FROM query_runs WHERE monitor_id=?")
        .get(user.monitor) as any
    ).code,
    "ID_JOVEM_UNCONFIRMED",
  );
  assert.equal(
    (
      db()
        .prepare("SELECT COUNT(*) AS n FROM alerts WHERE monitor_id=?")
        .get(user.monitor) as any
    ).n,
    0,
  );
});
test("diagnostics expose bounded codes instead of exception paths or credentials", () => {
  assert.equal(
    diagnosticCode(new Error("https://private.example/?token=secret")),
    "QUERY_FAILED",
  );
  assert.equal(
    diagnosticCode(new Error("Timeout 20000ms exceeded")),
    "BROWSER_TIMEOUT",
  );
  assert.equal(
    diagnosticCode(new Error("CLICKBUS_TRIPS_RESPONSE_TIMEOUT")),
    "CLICKBUS_TRIPS_RESPONSE_TIMEOUT",
  );
});
