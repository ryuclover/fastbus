import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { resolve, sep } from "node:path";
import { rmSync } from "node:fs";
import { db, closeDatabase } from "../lib/server/db";
import {
  requestContact,
  confirmContact,
  deliverVerification,
} from "../lib/monitoring/contact-verification";
import { getContact } from "../lib/monitoring/contact";
import { serviceId } from "../lib/server/whatsapp-service";
import { seal } from "../lib/server/crypto";
import { targetFor } from "../lib/monitoring/engine";
import {
  monitorSchema,
  today,
  type MonitorConfig,
} from "../lib/monitoring/schema";

const root = resolve("data", `verification-test-${randomUUID()}`);
process.env.FASTBUS_DATA_DIR = root;
process.env.FASTBUS_DATA_KEY = randomBytes(32).toString("hex");
after(() => {
  closeDatabase();
  if (!root.startsWith(resolve("data") + sep))
    throw new Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});
function user() {
  const id = randomUUID();
  db()
    .prepare(
      "INSERT INTO users(id,email_hash,profile,password,created_at) VALUES (?,?,?,?,?)",
    )
    .run(id, randomUUID(), seal({ name: "Teste" }, id), "not-used", Date.now());
  db()
    .prepare(
      "INSERT INTO whatsapp_service(id,desired,status,updated_at) VALUES (?,1,'ready',?) ON CONFLICT(id) DO UPDATE SET desired=1",
    )
    .run(serviceId, Date.now());
  db().prepare("DELETE FROM outbound_gates").run();
  return id;
}
let phoneIndex = 1000;
const phone = () => `+552199999${phoneIndex++}`;
async function sendCode() {
  let code = "";
  assert.equal(
    await deliverVerification({
      getNumberId: async (number) => ({ _serialized: `${number}@c.us` }),
      sendMessage: async (_recipient, message) => {
        code = message.match(/Seu código é: (\d{4})/)![1];
        return {};
      },
    }),
    true,
  );
  assert.match(code, /^\d{4}$/);
  return code;
}

test("a contact activates only after receiving and confirming its private single-use code", async () => {
  const id = user();
  const number = phone();
  await requestContact(id, number, true);
  assert.equal((await getContact(id)).enabled, false);
  await assert.rejects(confirmContact(id, "1234"));
  const code = await sendCode();
  const stored = db()
    .prepare("SELECT code,code_hash FROM contact_verifications WHERE user_id=?")
    .get(id) as { code: string | null; code_hash: string };
  assert.equal(stored.code, null);
  assert.equal(stored.code_hash.length, 64);
  assert.equal((await getContact(id)).enabled, false);
  await confirmContact(id, code);
  assert.equal((await getContact(id)).enabled, true);
  await assert.rejects(confirmContact(id, code));
  await requestContact(id, number, false);
  assert.equal((await getContact(id)).enabled, false);
  assert.equal(
    (await requestContact(id, number, true)).verificationRequired,
    false,
  );
  assert.equal((await getContact(id)).enabled, true);
});
test("wrong codes lock after five attempts, with no activation", async () => {
  const id = user();
  await requestContact(id, phone(), true);
  const code = await sendCode();
  const wrong = code === "0000" ? "0001" : "0000";
  for (let i = 0; i < 5; i++) await assert.rejects(confirmContact(id, wrong));
  await assert.rejects(confirmContact(id, code));
  assert.equal((await getContact(id)).enabled, false);
  assert.equal(
    (
      db()
        .prepare("SELECT status FROM contact_verifications WHERE user_id=?")
        .get(id) as { status: string }
    ).status,
    "locked",
  );
});
test("expired codes and codes from another account cannot activate a number", async () => {
  const a = user();
  await requestContact(a, phone(), true);
  const code = await sendCode();
  const b = user();
  await assert.rejects(confirmContact(b, code));
  db()
    .prepare("UPDATE contact_verifications SET expires_at=? WHERE user_id=?")
    .run(Date.now() - 1, a);
  await assert.rejects(confirmContact(a, code));
  assert.equal((await getContact(a)).enabled, false);
});
test("changing the destination invalidates verification and removes active consent until reconfirmed", async () => {
  const id = user();
  await requestContact(id, phone(), true);
  await confirmContact(id, await sendCode());
  await requestContact(id, phone(), true);
  assert.equal((await getContact(id)).enabled, false);
  assert.equal((await getContact(id)).verified, false);
  // Remove this pending test request so it cannot affect the next test's queue.
  db().prepare("DELETE FROM contact_verifications WHERE user_id=?").run(id);
});
test("failed or unregistered recipients never become verified and code delivery is not blindly retried", async () => {
  const id = user();
  await requestContact(id, phone(), true);
  assert.equal(
    await deliverVerification({
      getNumberId: async () => null,
      sendMessage: async () => assert.fail("Do not send"),
    }),
    false,
  );
  assert.equal((await getContact(id)).verificationStatus, "failed");
  await requestContact(id, phone(), true);
  assert.equal(
    await deliverVerification({
      getNumberId: async (number) => ({ _serialized: `${number}@c.us` }),
      sendMessage: async () => {
        throw new Error("offline");
      },
    }),
    false,
  );
  assert.equal((await getContact(id)).verificationStatus, "failed");
  assert.equal(
    await deliverVerification({
      getNumberId: async () => assert.fail("Must not retry"),
      sendMessage: async () => {},
    }),
    false,
  );
});
test("rolling windows stay active across months and enumerate exactly fourteen upcoming dates", () => {
  const config: MonitorConfig = {
    origin: "Rio de Janeiro::RJ",
    destination: "Salvador::BA",
    startDate: "2020-01-01",
    endDate: "2020-01-14",
    rollingWindow: 14,
    maxPrice: 100,
    intervalMinutes: 1440,
    benefit: "id100",
    providers: ["ClickBus"],
  };
  assert.equal(monitorSchema.safeParse(config).success, true);
  const dates = Array.from(
    { length: 14 },
    (_, i) => targetFor(config, i)!.date,
  );
  dates.sort();
  assert.equal(dates[0], today());
  assert.equal(new Set(dates).size, 14);
  assert.equal(
    dates[13],
    new Date(Date.parse(today()) + 13 * 86400000).toISOString().slice(0, 10),
  );
  assert.equal(targetFor(config, 140)!.date, targetFor(config, 0)!.date);
  assert.equal(targetFor({ ...config, rollingWindow: undefined }, 0), null);
});
