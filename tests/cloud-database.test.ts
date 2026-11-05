import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { resolve, sep } from "node:path";
import { db, transaction, closeDatabase } from "../lib/server/database";
import { claimWorker, releaseWorker } from "../lib/monitoring/lease";
import { monitorSchema, today } from "../lib/monitoring/schema";
import { GET } from "../app/api/cron/monitor/route";

const root = resolve("data", `cloud-test-${randomUUID()}`);
process.env.FASTBUS_DATA_DIR = root;
after(() => {
  closeDatabase();
  if (!root.startsWith(resolve("data") + sep))
    throw new Error("Unsafe cleanup");
  rmSync(root, { recursive: true, force: true });
});

test("async transactions roll back and isolate unrelated concurrent operations", async () => {
  let entered!: () => void;
  let resume!: () => void;
  const inside = new Promise<void>((done) => {
    entered = done;
  });
  const resumeTransaction = new Promise<void>((done) => {
    resume = done;
  });
  const first = transaction(async () => {
    await db().prepare("INSERT INTO limits VALUES ('rollback',1,1)").run();
    entered();
    await resumeTransaction;
    throw new Error("rollback");
  });
  const rejected = assert.rejects(first, /rollback/);
  await inside;
  const unrelated = db()
    .prepare("INSERT INTO limits VALUES ('committed',1,1)")
    .run();
  resume();
  await Promise.all([rejected, unrelated]);
  assert.equal(
    await db().prepare("SELECT key FROM limits WHERE key='rollback'").get(),
    undefined,
  );
  assert.ok(
    await db().prepare("SELECT key FROM limits WHERE key='committed'").get(),
  );
});

test("workers share one durable lease and release only their own ownership", async () => {
  const owners = [randomUUID(), randomUUID()];
  const claims = await Promise.all(owners.map(claimWorker));
  assert.equal(claims.filter(Boolean).length, 1);
  const winner = owners[claims.indexOf(true)];
  const loser = owners[claims.indexOf(false)];
  await releaseWorker(loser);
  assert.equal(await claimWorker(loser), false);
  await releaseWorker(winner);
  assert.equal(await claimWorker(loser), true);
  await releaseWorker(loser);
});

test("cloud monitors require a daily interval without changing local validation", () => {
  const input = {
    origin: "Rio de Janeiro::RJ",
    destination: "Sao Paulo::SP",
    startDate: today(),
    endDate: today(),
    maxPrice: 100,
    intervalMinutes: 60,
    benefit: "id100",
    providers: ["ClickBus"],
  };
  process.env.FASTBUS_CLOUD_MODE = "daily";
  try {
    assert.equal(monitorSchema.safeParse(input).success, false);
    assert.equal(
      monitorSchema.safeParse({ ...input, intervalMinutes: 1440 }).success,
      true,
    );
  } finally {
    delete process.env.FASTBUS_CLOUD_MODE;
  }
  assert.equal(monitorSchema.safeParse(input).success, true);
});

test("cron fails closed without its secret and rejects invalid credentials", async () => {
  delete process.env.CRON_SECRET;
  assert.equal(
    (await GET(new Request("https://fastbus.example/api/cron/monitor"))).status,
    401,
  );
  process.env.CRON_SECRET = randomUUID();
  try {
    for (const authorization of [
      "",
      "Bearer invalid",
      `Bearer ${"x".repeat(process.env.CRON_SECRET.length)}`,
    ]) {
      assert.equal(
        (
          await GET(
            new Request("https://fastbus.example/api/cron/monitor", {
              headers: { authorization },
            }),
          )
        ).status,
        401,
      );
    }
  } finally {
    delete process.env.CRON_SECRET;
  }
});
