import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
const root = "http://127.0.0.1:3000";
const origin = "http://localhost:3000";
const email = `smoke-${randomUUID()}@example.com`;
const password = randomBytes(24).toString("hex");
let cookie = "";
async function call(path, method = "GET", input, requestOrigin = origin) {
  return fetch(root + path, {
    method,
    headers: {
      origin: requestOrigin,
      ...(input ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
    },
    body: input ? JSON.stringify(input) : undefined,
  });
}
try {
  const anon = await call("/api/monitors");
  assert.equal(anon.status, 401);
  const csrf = await call(
    "/api/account/register",
    "POST",
    { name: "Smoke", email, password },
    "https://attacker.example",
  );
  assert.equal(csrf.status, 403);
  const registration = await call("/api/account/register", "POST", {
    name: "Teste temporário",
    email,
    password,
  });
  assert.equal(registration.status, 200, await registration.text());
  cookie = registration.headers.get("set-cookie").split(";")[0];
  assert.match(registration.headers.get("set-cookie"), /HttpOnly/i);
  assert.equal(registration.headers.get("cache-control"), "no-store");
  const me = await call("/api/account/me");
  assert.equal((await me.json()).user.email, email);
  assert.equal(me.headers.get("x-frame-options"), "DENY");
  assert.equal(me.headers.get("x-powered-by"), null);
  const deleted = await call("/api/account/delete", "POST", { password });
  assert.equal(deleted.status, 200);
  const invalidated = await call("/api/monitors");
  assert.equal(invalidated.status, 401);
  cookie = "";
  console.log(
    "HTTP real verificado: cadastro, sessão, CSRF, cabeçalhos de segurança, exclusão e revogação. Conta temporária removida.",
  );
} finally {
  if (cookie) await call("/api/account/delete", "POST", { password });
}
