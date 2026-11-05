import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, closeDatabase } from "../lib/server/db";
import {
  mappedCity,
  withLocationMappings,
} from "../lib/server/location-mappings";

test("verified aliases survive reopening SQLite, isolate providers and refresh after expiry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fastbus-location-"));
  const previous = {
    dir: process.env.FASTBUS_DATA_DIR,
    url: process.env.TURSO_DATABASE_URL,
    vercel: process.env.VERCEL,
  };
  process.env.FASTBUS_DATA_DIR = dir;
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.VERCEL;
  let calls = 0;
  const resolve = (provider: string) =>
    withLocationMappings(() =>
      mappedCity(provider, "cidade-sp", async () => {
        calls++;
        return "cidade-sp-todos";
      }),
    );
  try {
    await resolve("ClickBus");
    closeDatabase();
    await resolve("ClickBus");
    assert.equal(calls, 1);
    await resolve("Mobifacil");
    assert.equal(calls, 2);
    db()
      .prepare(
        "UPDATE location_mappings SET verified_at=0 WHERE provider='ClickBus'",
      )
      .run();
    await resolve("ClickBus");
    assert.equal(calls, 3);
    db()
      .prepare(
        "UPDATE location_mappings SET version=0 WHERE provider='ClickBus'",
      )
      .run();
    await resolve("ClickBus");
    assert.equal(calls, 4);
    await assert.rejects(
      withLocationMappings(() =>
        mappedCity("ClickBus", "outra-sp", async () => {
          throw new Error("LOCATION_AMBIGUOUS");
        }),
      ),
    );
    assert.equal(
      db()
        .prepare(
          "SELECT COUNT(*) AS n FROM location_mappings WHERE city_key='outra-sp'",
        )
        .get()?.n,
      0,
    );
  } finally {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of Object.entries({
      FASTBUS_DATA_DIR: previous.dir,
      TURSO_DATABASE_URL: previous.url,
      VERCEL: previous.vercel,
    })) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
