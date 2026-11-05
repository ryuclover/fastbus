import { offerEvidence } from "../lib/scrapers/offer-evidence";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { NextRequest } from "next/server";
import { db, closeDatabase } from "../lib/server/db";
import { seal } from "../lib/server/crypto";
import { serviceId } from "../lib/server/whatsapp-service";
import {
  sendWithTransport,
  type AlertTransport,
} from "../lib/monitoring/whatsapp";
import type { AlertPayload } from "../lib/monitoring/engine";
import * as account from "../app/api/account/[action]/route";
import * as contact from "../app/api/whatsapp/route";
import * as admin from "../app/api/admin/whatsapp/route";

const root = resolve("data", `admin-test-${randomUUID()}`);
process.env.FASTBUS_DATA_DIR = root;
process.env.FASTBUS_DATA_KEY = randomBytes(32).toString("hex");
process.env.APP_ORIGIN = "http://localhost:3000";
process.env.FASTBUS_ALLOW_REGISTRATION = "true";
mkdirSync(root, { recursive: true });
after(() => {
  closeDatabase();
  if (!root.startsWith(resolve("data") + sep))
    throw new Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
const password = "uma-senha-forte-2026";
const ctx = (action: string) => ({ params: Promise.resolve({ action }) });
function req(
  path: string,
  cookie = "",
  input?: unknown,
  origin = "http://localhost:3000",
) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method: input ? "POST" : "GET",
    headers: {
      cookie,
      origin,
      ...(input ? { "content-type": "application/json" } : {}),
    },
    body: input ? JSON.stringify(input) : undefined,
  });
}
async function register() {
  const email = `${randomUUID()}@example.com`;
  const response = await account.POST(
    req("/api/account/register", "", { name: "Teste", email, password }),
    ctx("register"),
  );
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")!.split(";")[0];
  const me = await account.GET(req("/api/account/me", cookie), ctx("me"));
  return { cookie, user: (await me.json()).user, email };
}
const payload: AlertPayload = {
  origin: "Rio de Janeiro::RJ",
  destination: "Sao Paulo::SP",
  date: "2026-12-01",
  departure: "12:00",
  company: "Teste",
  provider: "Guanabara",
  price: 99,
  benefit: "nenhuma",
  url: "https://viajeguanabara.com.br",
  observedAt: Date.now(),
};
function enableSender() {
  db()
    .prepare(
      "INSERT INTO whatsapp_service(id,desired,status,updated_at) VALUES (?,1,'ready',?) ON CONFLICT(id) DO UPDATE SET desired=1,status='ready'",
    )
    .run(serviceId, Date.now());
}
function verifiedFixture(userId: string) {
  // Alert transport tests start with an already verified contact; OTP is tested separately.
  db()
    .prepare(
      "UPDATE contact_verifications SET status='verified',code=NULL,code_hash=NULL WHERE user_id=?",
    )
    .run(userId);
  db()
    .prepare("UPDATE notification_contacts SET enabled=1 WHERE user_id=?")
    .run(userId);
}

test("regular registration cannot self-grant admin, and ordinary accounts cannot read QR or control sender", async () => {
  const result = await account.POST(
    req("/api/account/register", "", {
      name: "Teste",
      email: "attack@example.com",
      password,
      role: "admin",
    }),
    ctx("register"),
  );
  assert.equal(result.status, 400);
  const a = await register();
  assert.equal(a.user.role, "user");
  assert.equal((await admin.GET(req("/api/admin/whatsapp"))).status, 401);
  assert.equal(
    (await admin.GET(req("/api/admin/whatsapp", a.cookie))).status,
    403,
  );
  assert.equal(
    (
      await admin.POST(
        req("/api/admin/whatsapp", a.cookie, { connect: true, password }),
      )
    ).status,
    403,
  );
  assert.equal(
    (await contact.POST(req("/api/whatsapp", a.cookie, { connect: true })))
      .status,
    400,
  );
});
test("an authenticated admin configures WhatsApp without repeating a password; CSRF and QR isolation remain enforced", async () => {
  const a = await register();
  db().prepare("UPDATE users SET role='admin' WHERE id=?").run(a.user.id);
  assert.equal(
    (
      await admin.POST(
        req("/api/admin/whatsapp", a.cookie, {
          connect: true,
        }),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      await admin.POST(
        req(
          "/api/admin/whatsapp",
          a.cookie,
          { connect: true, password },
          "https://attacker.test",
        ),
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await admin.POST(
        req("/api/admin/whatsapp", a.cookie, { connect: true, password }),
      )
    ).status,
    200,
  );
  db()
    .prepare(
      "UPDATE whatsapp_service SET status='qr',qr=?,qr_expires=? WHERE id=?",
    )
    .run(
      seal("data:image/png;base64,fixture", serviceId),
      Date.now() + 60000,
      serviceId,
    );
  const response = await admin.GET(req("/api/admin/whatsapp", a.cookie));
  assert.equal((await response.json()).qr, "data:image/png;base64,fixture");
  assert.equal(response.headers.get("cache-control"), "no-store");
  const regularResponse = await contact.GET(req("/api/whatsapp", a.cookie));
  assert.equal("qr" in (await regularResponse.json()), false);
  db()
    .prepare("UPDATE whatsapp_service SET qr_expires=0 WHERE id=?")
    .run(serviceId);
  assert.equal(
    (await (await admin.GET(req("/api/admin/whatsapp", a.cookie))).json()).qr,
    null,
  );
  db()
    .prepare(
      "UPDATE whatsapp_service SET status='error',last_error='BROWSER_NAVIGATION',retry_at=? WHERE id=?",
    )
    .run(Date.now() + 300000, serviceId);
  const failed = await (
    await admin.GET(req("/api/admin/whatsapp", a.cookie))
  ).json();
  assert.match(failed.error, /recarregou/);
  assert.equal(
    (
      await admin.POST(
        req("/api/admin/whatsapp", a.cookie, {
          connect: true,
          password,
          retry: true,
        }),
      )
    ).status,
    200,
  );
  const retried = db()
    .prepare(
      "SELECT status,last_error,retry_at FROM whatsapp_service WHERE id=?",
    )
    .get(serviceId) as {
    status: string;
    last_error: string | null;
    retry_at: number | null;
  };
  assert.deepEqual(
    { ...retried },
    { status: "queued", last_error: null, retry_at: null },
  );
  assert.equal(
    (
      await admin.POST(
        req("/api/admin/whatsapp", a.cookie, { connect: false, password }),
      )
    ).status,
    200,
  );
});
test("temporary admin password blocks QR access until changed and sessions are revoked", async () => {
  const a = await register();
  db()
    .prepare("UPDATE users SET role='admin',must_change_password=1 WHERE id=?")
    .run(a.user.id);
  assert.equal(
    (await admin.GET(req("/api/admin/whatsapp", a.cookie))).status,
    403,
  );
  assert.equal(
    (
      await account.POST(
        req("/api/account/password", a.cookie, {
          password,
          newPassword: "nova-senha-pessoal-2026",
        }),
        ctx("password"),
      )
    ).status,
    200,
  );
  assert.equal(
    (await admin.GET(req("/api/admin/whatsapp", a.cookie))).status,
    401,
  );
  const login = await account.POST(
    req("/api/account/login", "", {
      email: a.email,
      password: "nova-senha-pessoal-2026",
    }),
    ctx("login"),
  );
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  assert.equal(
    (await admin.GET(req("/api/admin/whatsapp", cookie))).status,
    200,
  );
});
test("destination requires opt-in and international number; phones are encrypted and isolated by user", async () => {
  const a = await register();
  const b = await register();
  for (const phone of [
    "11999999999",
    "+5511999999999@g.us",
    "https://attacker.test",
    "+00000000",
  ]) {
    assert.equal(
      (
        await contact.POST(
          req("/api/whatsapp", a.cookie, {
            phone,
            consent: true,
            enabled: true,
          }),
        )
      ).status,
      400,
    );
  }
  assert.equal(
    (
      await contact.POST(
        req("/api/whatsapp", a.cookie, {
          phone: "+5511999999999",
          consent: false,
          enabled: true,
        }),
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await contact.POST(
        req("/api/whatsapp", a.cookie, {
          phone: "+55 (11) 99999-9999",
          consent: true,
          enabled: true,
        }),
      )
    ).status,
    200,
  );
  const stored = db()
    .prepare("SELECT phone FROM notification_contacts WHERE user_id=?")
    .get(a.user.id) as { phone: string };
  assert.ok(!stored.phone.includes("5511999999999"));
  assert.equal(
    (await (await contact.GET(req("/api/whatsapp", a.cookie))).json()).phone,
    "+5511999999999",
  );
  assert.equal(
    (await (await contact.GET(req("/api/whatsapp", b.cookie))).json()).phone,
    "",
  );
});
test("central sender delivers only to chosen number; durable per-number limit spans accounts", async () => {
  const a = await register();
  const b = await register();
  enableSender();
  db().prepare("DELETE FROM outbound_gates").run();
  for (const user of [a, b])
    await contact.POST(
      req("/api/whatsapp", user.cookie, {
        phone: "+5511988888888",
        consent: true,
        enabled: true,
      }),
    );
  const sent: string[] = [];
  for (const user of [a, b]) verifiedFixture(user.user.id);
  const lookedUp: string[] = [];
  const transport: AlertTransport = {
    getNumberId: async (number) => {
      lookedUp.push(number);
      return { _serialized: `${number}@c.us` };
    },
    sendMessage: async (id, text) => {
      sent.push(id);
      assert.match(text, /FastBus/);
      return {};
    },
  };
  assert.equal(await sendWithTransport(transport, a.user.id, payload), true);
  assert.deepEqual(sent, ["5511988888888@c.us"]);
  assert.equal(lookedUp[0], "5511988888888");
  assert.equal(await sendWithTransport(transport, b.user.id, payload), false);
  assert.equal(sent.length, 1);
});
test("ClickBus youth alert identifies the fare and warns that fees and final total require confirmation", async () => {
  const a = await register();
  enableSender();
  db().prepare("DELETE FROM outbound_gates").run();
  await contact.POST(
    req("/api/whatsapp", a.cookie, {
      phone: "+5511977777777",
      consent: true,
      enabled: true,
    }),
  );
  let message = "";
  verifiedFixture(a.user.id);
  const transport: AlertTransport = {
    getNumberId: async () => ({ _serialized: "5511977777777@c.us" }),
    sendMessage: async (_id, text) => {
      message = text;
      return {};
    },
  };
  assert.equal(
    await sendWithTransport(transport, a.user.id, {
      ...payload,
      provider: "ClickBus",
      price: 0,
      benefit: "id_jovem_100",
      evidence: offerEvidence(
        {
          empresa: "Fixture",
          valorNumerico: 0,
          tipoGratuidade: "id_jovem_100",
          vagasIdJovem: 1,
        },
        "ClickBus",
        payload.date,
        payload.observedAt,
      ),
      url: "https://www.clickbus.com.br/viagem?tripId=test",
    }),
    true,
  );
  assert.match(message, /Tarifa informada/);
  assert.match(message, /Taxas e valor final a confirmar/);
});
test("a trip that departs during recipient lookup never reaches WhatsApp or consumes the send slot", async () => {
  const a = await register();
  enableSender();
  db().prepare("DELETE FROM outbound_gates").run();
  await contact.POST(
    req("/api/whatsapp", a.cookie, {
      phone: "+5511977777777",
      consent: true,
      enabled: true,
    }),
  );
  verifiedFixture(a.user.id);
  const original = Date.now;
  const start = original();
  let clock = start;
  Date.now = () => clock;
  let lookups = 0;
  try {
    const sent = await sendWithTransport(
      {
        getNumberId: async () => {
          lookups++;
          clock = start + 2000;
          return { _serialized: "5511977777777@c.us" };
        },
        sendMessage: async () =>
          assert.fail("departure passed during number lookup"),
      },
      a.user.id,
      { ...payload, departureAt: start + 2000, observedAt: start },
    );
    assert.equal(lookups, 1);
    assert.equal(sent, false);
    assert.equal(
      db().prepare("SELECT count(*) AS n FROM outbound_gates").get()?.n,
      0,
    );
  } finally {
    Date.now = original;
  }
});

test("disabled, changed or deleted contact prevents sending even after lookup", async () => {
  const a = await register();
  enableSender();
  db().prepare("DELETE FROM outbound_gates").run();
  let sends = 0;
  const transport: AlertTransport = {
    getNumberId: async (number) => ({ _serialized: `${number}@c.us` }),
    sendMessage: async () => {
      sends++;
    },
  };
  assert.equal(await sendWithTransport(transport, a.user.id, payload), false);
  await contact.POST(
    req("/api/whatsapp", a.cookie, {
      phone: "+5511977777777",
      consent: true,
      enabled: true,
    }),
  );
  verifiedFixture(a.user.id);
  await contact.POST(
    req("/api/whatsapp", a.cookie, {
      phone: "+5511977777777",
      consent: true,
      enabled: false,
    }),
  );
  assert.equal(await sendWithTransport(transport, a.user.id, payload), false);
  db()
    .prepare("UPDATE notification_contacts SET enabled=1 WHERE user_id=?")
    .run(a.user.id);
  const racing: AlertTransport = {
    ...transport,
    getNumberId: async (number) => {
      db()
        .prepare("DELETE FROM notification_contacts WHERE user_id=?")
        .run(a.user.id);
      return { _serialized: `${number}@c.us` };
    },
  };
  assert.equal(await sendWithTransport(racing, a.user.id, payload), false);
  assert.equal(sends, 0);
});
test("last administrator must disconnect the sender before deleting their account", async () => {
  const a = await register();
  db().prepare("UPDATE users SET role='user'").run();
  db().prepare("UPDATE users SET role='admin' WHERE id=?").run(a.user.id);
  enableSender();
  assert.equal(
    (
      await account.POST(
        req("/api/account/delete", a.cookie, { password }),
        ctx("delete"),
      )
    ).status,
    409,
  );
  db()
    .prepare("UPDATE whatsapp_service SET desired=0 WHERE id=?")
    .run(serviceId);
  assert.equal(
    (
      await account.POST(
        req("/api/account/delete", a.cookie, { password }),
        ctx("delete"),
      )
    ).status,
    200,
  );
});
test("unregistered WhatsApp number is not sent to, and deleting a normal account keeps central sender", async () => {
  const a = await register();
  enableSender();
  await contact.POST(
    req("/api/whatsapp", a.cookie, {
      phone: "+5511966666666",
      consent: true,
      enabled: true,
    }),
  );
  verifiedFixture(a.user.id);
  await assert.rejects(
    sendWithTransport(
      {
        getNumberId: async () => null,
        sendMessage: async () => assert.fail("Must not send"),
      },
      a.user.id,
      payload,
    ),
    /RECIPIENT_NOT_ON_WHATSAPP/,
  );
  assert.equal(
    (
      await account.POST(
        req("/api/account/delete", a.cookie, { password }),
        ctx("delete"),
      )
    ).status,
    200,
  );
  assert.equal(
    (
      db()
        .prepare("SELECT desired FROM whatsapp_service WHERE id=?")
        .get(serviceId) as { desired: number }
    ).desired,
    1,
  );
  assert.equal(
    db()
      .prepare("SELECT * FROM notification_contacts WHERE user_id=?")
      .get(a.user.id),
    undefined,
  );
});
