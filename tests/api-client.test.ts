import { test } from "node:test";
import assert from "node:assert/strict";
import { api } from "../lib/api-client";

test("interface JSON requests preserve cookies, no-store and mutation payloads", async () => {
  const original = globalThis.fetch;
  const requests: RequestInit[] = [];
  globalThis.fetch = async (_path, options) => {
    requests.push(options!);
    return Response.json({ ok: true });
  };
  try {
    assert.deepEqual(await api("/api/monitors"), { ok: true });
    await api("/api/whatsapp", "POST", { enabled: false, consent: true });
    await api("/api/whatsapp", "DELETE");
    for (const request of requests) {
      assert.equal(request.credentials, "same-origin");
      assert.equal(request.cache, "no-store");
    }
    assert.equal(requests[0].body, undefined);
    assert.deepEqual(requests[1].headers, {
      "Content-Type": "application/json",
    });
    assert.deepEqual(JSON.parse(requests[1].body as string), {
      enabled: false,
      consent: true,
    });
    assert.equal(requests[2].method, "DELETE");
    assert.equal(requests[2].headers, undefined);
  } finally {
    globalThis.fetch = original;
  }
});

test("interface errors retain HTTP status, server messages and caller fallbacks", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () =>
      Response.json({ error: "Entre na sua conta." }, { status: 401 });
    await assert.rejects(api("/api/monitors"), {
      message: "Entre na sua conta.",
      status: 401,
    });
    globalThis.fetch = async () => Response.json({}, { status: 503 });
    await assert.rejects(
      api("/api/whatsapp", "GET", undefined, "Falha no contato."),
      { message: "Falha no contato.", status: 503 },
    );
    await assert.rejects(api("/api/monitors"), {
      message: "Não foi possível concluir a operação.",
      status: 503,
    });
  } finally {
    globalThis.fetch = original;
  }
});
