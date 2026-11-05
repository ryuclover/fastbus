import { config } from "dotenv";
config({ path: ".env.local", quiet: true });
config({ quiet: true });
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { db, closeDatabase, transaction } from "../lib/server/database";
import { emailIndex, hashPassword, seal } from "../lib/server/crypto";
async function main() {
  const email = z
    .string()
    .email()
    .max(254)
    .parse(process.argv[2]?.trim().toLowerCase());
  const existing = (await db()
    .prepare("SELECT id FROM users WHERE email_hash=?")
    .get(emailIndex(email))) as
    | {
        id: string;
      }
    | undefined;
  let temporaryPassword: string | undefined;
  if (process.argv.includes("--reset-password")) {
    if (!existing) throw new Error("Conta não encontrada.");
    temporaryPassword = randomBytes(18).toString("base64url");
    const hash = await hashPassword(temporaryPassword);
    await transaction(async () => {
      await db()
        .prepare(
          "UPDATE users SET password=?,must_change_password=1 WHERE id=?",
        )
        .run(hash, existing.id);
      await db()
        .prepare("DELETE FROM sessions WHERE user_id=?")
        .run(existing.id);
      await db()
        .prepare("DELETE FROM password_recovery WHERE user_id=?")
        .run(existing.id);
    });
    console.log(
      JSON.stringify({
        email,
        temporaryPassword,
        mustChangePassword: true,
        message:
          "Entregue a senha temporária somente ao titular por um canal confiável. O papel da conta foi preservado.",
      }),
    );
    return;
  }
  if (!existing && !process.argv.includes("--create"))
    throw new Error(
      "Conta não encontrada. Cadastre-a no site ou use --create para gerar uma senha inicial.",
    );
  const id = existing?.id || randomUUID();
  if (!existing) {
    temporaryPassword = randomBytes(18).toString("base64url");
    const hash = await hashPassword(temporaryPassword);
    await db()
      .prepare(
        "INSERT INTO users(id,email_hash,profile,password,created_at,role,must_change_password) VALUES (?,?,?,?,?,'admin',1)",
      )
      .run(
        id,
        emailIndex(email),
        seal({ name: "Administrador FastBus", email }, id),
        hash,
        Date.now(),
      );
  } else
    await transaction(async () => {
      await db().prepare("UPDATE users SET role='admin' WHERE id=?").run(id);
      await db().prepare("DELETE FROM sessions WHERE user_id=?").run(id);
    });
  console.log(
    JSON.stringify({
      email,
      role: "admin",
      ...(temporaryPassword
        ? { temporaryPassword, mustChangePassword: true }
        : { message: "Conta promovida; entre novamente com sua senha atual." }),
    }),
  );
}
void main()
  .catch((error) => {
    console.error(
      error instanceof Error ? error.message : "Falha ao configurar admin",
    );
    process.exitCode = 1;
  })
  .finally(closeDatabase);
