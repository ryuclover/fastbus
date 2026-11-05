import { test, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join, sep } from "node:path";
import { db, closeDatabase } from "../lib/server/db";
import { seal } from "../lib/server/crypto";
import {
  serviceId,
  serviceStatus,
  finishWhatsAppExecution,
} from "../lib/server/whatsapp-service";
import {
  archiveSessionProfile,
  assertSessionArchive,
  includeProfilePath,
} from "../lib/monitoring/session-profile";
import {
  EncryptedWhatsAppStore,
  syncWhatsApp,
  createAuth,
  authSessionName,
} from "../lib/monitoring/whatsapp";

const root = resolve("data", `store-test-${randomUUID()}`);
process.env.FASTBUS_DATA_DIR = root;
process.env.FASTBUS_RUNTIME_DIR = join(root, "runtime");
process.env.FASTBUS_DATA_KEY = randomBytes(32).toString("hex");
mkdirSync(root, { recursive: true });
after(() => {
  closeDatabase();
  if (!root.startsWith(resolve("data") + sep))
    throw new Error("Unsafe test cleanup");
  rmSync(root, { recursive: true, force: true });
});
test("RemoteAuth saves encrypted archive, restores bytes and enforces ownership/path", async () => {
  const id = serviceId;
  db()
    .prepare(
      "INSERT INTO users(id,email_hash,profile,password,created_at) VALUES (?,?,?,?,?)",
    )
    .run(id, randomUUID(), seal({ name: "Teste" }, id), "not-used", Date.now());
  db()
    .prepare(
      "INSERT INTO whatsapp_service(id,desired,status,updated_at) VALUES (?,1,'ready',?)",
    )
    .run(id, Date.now());
  const session = authSessionName;
  const archive = join(root, `${session}.zip`);
  const profile = join(root, "fixture-profile");
  mkdirSync(join(profile, "Default", "IndexedDB"), { recursive: true });
  mkdirSync(join(profile, "Default", "Local Storage"), { recursive: true });
  writeFileSync(
    join(profile, "Default", "IndexedDB", "fixture.ldb"),
    "session-credential-fixture",
  );
  writeFileSync(
    join(profile, "Default", "Local Storage", "fixture.ldb"),
    "local-storage-fixture",
  );
  writeFileSync(join(profile, "Local State"), "state-fixture");
  await archiveSessionProfile(profile, join(root, "fixture-stage"), archive);
  const secret = readFileSync(archive);
  const store = new EncryptedWhatsAppStore(id, root);
  await store.save({ session });
  const saved = db()
    .prepare("SELECT backup FROM whatsapp_service WHERE id=?")
    .get(id) as { backup: string };
  assert.ok(!saved.backup.includes(secret.toString()));
  assert.ok(await store.sessionExists({ session }));
  writeFileSync(archive, "");
  await store.extract({ session, path: archive });
  assert.deepEqual(readFileSync(archive), secret);
  await assert.rejects(
    store.extract({ session, path: join(root, "other.zip") }),
  );
  await assert.rejects(
    store.sessionExists({ session: "RemoteAuth-another-user" }),
  );
  await store.delete({ session });
  assert.equal(await store.sessionExists({ session }), false);
  db().prepare("UPDATE whatsapp_service SET desired=0 WHERE id=?").run(id);
});
test("incomplete legacy archives are rejected without replacing a valid backup, and process locks/caches are excluded", async () => {
  db()
    .prepare("UPDATE whatsapp_service SET desired=1 WHERE id=?")
    .run(serviceId);
  const store = new EncryptedWhatsAppStore(serviceId, root);
  const profile = join(root, "incomplete-profile");
  mkdirSync(join(profile, "Default", "IndexedDB"), { recursive: true });
  writeFileSync(
    join(profile, "Default", "IndexedDB", "fixture.ldb"),
    "indexeddb-only",
  );
  const archive = join(root, `${authSessionName}.zip`);
  await archiveSessionProfile(profile, join(root, "incomplete-stage"), archive);
  const bytes = readFileSync(archive);
  await assert.rejects(
    assertSessionArchive(bytes),
    /SESSION_BACKUP_INCOMPLETE/,
  );
  const previous = seal(bytes.toString("base64"), serviceId);
  db()
    .prepare("UPDATE whatsapp_service SET backup=? WHERE id=?")
    .run(previous, serviceId);
  assert.equal(await store.sessionExists({ session: authSessionName }), false);
  await assert.rejects(
    store.save({ session: authSessionName }),
    /SESSION_BACKUP_INCOMPLETE/,
  );
  assert.equal(
    (
      db()
        .prepare("SELECT backup FROM whatsapp_service WHERE id=?")
        .get(serviceId) as any
    ).backup,
    previous,
  );
  assert.equal(
    includeProfilePath(
      profile,
      join(profile, "Default", "Local Storage", "fixture.ldb"),
    ),
    true,
  );
  assert.equal(
    includeProfilePath(profile, join(profile, "Default", "Cache", "fixture")),
    false,
  );
  assert.equal(
    includeProfilePath(profile, join(profile, "SingletonLock")),
    false,
  );
  assert.equal(
    includeProfilePath(profile, join(profile, "..", "outside")),
    false,
  );
  db()
    .prepare("UPDATE whatsapp_service SET desired=0 WHERE id=?")
    .run(serviceId);
});
test("RemoteAuth cancels delayed initial backup when stopped before pairing finishes", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const auth = createAuth(serviceId, root);
  let saves = 0;
  Object.assign(auth, {
    storeRemoteSession: async () => {
      saves++;
    },
  });
  await auth.afterAuthReady();
  await auth.destroy();
  t.mock.timers.tick(180000);
  assert.equal(saves, 0);
  t.mock.timers.reset();
});
test("a fresh pairing has a stability interval before the cloud worker may close and checkpoint it", async (t) => {
  t.mock.timers.enable({
    apis: ["setTimeout", "Date"],
    now: Date.UTC(2026, 10, 3),
  });
  const auth = createAuth(serviceId, root);
  Object.assign(auth, { storeRemoteSession: async () => {} });
  await auth.afterAuthReady();
  assert.equal(auth.stable(), false);
  t.mock.timers.tick(59999);
  assert.equal(auth.stable(), false);
  t.mock.timers.tick(1);
  assert.equal(auth.stable(), true);
  await auth.destroy();
  t.mock.timers.reset();
});
test("a rejected restored session is never reported as sleeping merely because a backup exists", async () => {
  db()
    .prepare(
      "UPDATE whatsapp_service SET desired=1,status='qr',backup='old-backup',last_error=NULL WHERE id=?",
    )
    .run(serviceId);
  await finishWhatsAppExecution();
  const failed = await serviceStatus(true);
  assert.equal(failed.status, "error");
  assert.equal(failed.sessionStored, false);
  assert.match(failed.error!, /não aceitou/);
  db()
    .prepare(
      "UPDATE whatsapp_service SET status='ready',last_error=NULL WHERE id=?",
    )
    .run(serviceId);
  await finishWhatsAppExecution();
  const saved = await serviceStatus();
  assert.equal(saved.status, "sleeping");
  assert.equal(saved.sessionStored, true);
  db()
    .prepare("UPDATE whatsapp_service SET desired=0 WHERE id=?")
    .run(serviceId);
});
test("worker removes browser profiles belonging to accounts deleted while offline", async () => {
  const id = randomUUID();
  const profile = join(process.env.FASTBUS_RUNTIME_DIR!, id);
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "fixture"), "old-session");
  await syncWhatsApp();
  assert.throws(() => readFileSync(join(profile, "fixture")));
});

test("a legacy backup cannot be advertised as a profile saved in the Daytona workspace", async () => {
  process.env.FASTBUS_WHATSAPP_RUNTIME = "daytona";
  process.env.DAYTONA_SANDBOX_ID = "fixture-workspace";
  try {
    db()
      .prepare(
        "UPDATE whatsapp_service SET desired=1,status='ready',backup='legacy',last_error=NULL WHERE id=?",
      )
      .run(serviceId);
    assert.equal((await serviceStatus()).sessionStored, false);
    db()
      .prepare(
        "UPDATE whatsapp_service SET backup='daytona:fixture-workspace' WHERE id=?",
      )
      .run(serviceId);
    assert.equal((await serviceStatus()).sessionStored, true);
  } finally {
    delete process.env.FASTBUS_WHATSAPP_RUNTIME;
    delete process.env.DAYTONA_SANDBOX_ID;
    db()
      .prepare("UPDATE whatsapp_service SET desired=0 WHERE id=?")
      .run(serviceId);
  }
});
