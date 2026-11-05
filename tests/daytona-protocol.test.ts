import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { daytonaHandler } from "../lib/monitoring/daytona-protocol";

test("WhatsApp channel authenticates every operation and never repeats an ambiguous send", async () => {
  const secret = randomBytes(32).toString("hex");
  let sends = 0;
  const server = createServer(
    daytonaHandler(
      secret,
      {
        state: () => ({ status: "ready", stable: true }),
        number: async (phone) => ({ _serialized: `${phone}@c.us` }),
        send: async () => {
          sends++;
          throw new Error("FIXTURE_SEND_FAILED");
        },
        checkpoint: async () => {},
        stop: async () => {},
      },
      () => {},
    ),
  );
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = (path: string, body?: unknown, auth = secret) =>
    fetch(origin + path, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${auth}`,
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  try {
    assert.equal((await call("/state", undefined, "wrong")).status, 401);
    assert.equal((await call("/state")).status, 200);
    assert.equal((await call("/sql", { query: "SELECT 1" })).status, 404);
    assert.equal(
      (await call("/number", { phone: "https://example.com" })).status,
      400,
    );
    const request = {
      id: randomUUID(),
      to: "5521999999999@c.us",
      text: "Fixture",
    };
    assert.equal(
      (await call("/send", { ...request, to: "group@g.us" })).status,
      400,
    );
    assert.equal((await call("/send", request)).status, 503);
    assert.equal((await call("/send", request)).status, 503);
    assert.equal(sends, 1);
    assert.equal(
      (await call("/send", { ...request, text: "Changed" })).status,
      409,
    );
    assert.equal(
      (await call("/checkpoint", { command: "unexpected" })).status,
      400,
    );
  } finally {
    await new Promise<void>((done) => server.close(() => done()));
  }
});
