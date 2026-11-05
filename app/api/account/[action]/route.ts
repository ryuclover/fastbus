import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { z } from "zod";
import { db, rateLimit, transaction } from "@/lib/server/database";
import {
  digest,
  emailIndex,
  hashPassword,
  seal,
  token,
  verifyPassword,
} from "@/lib/server/crypto";
import {
  body,
  cookieName,
  currentUser,
  endpoint,
  HttpError,
  json,
  originCheck,
  requireUser,
  sessionCookieOptions,
} from "@/lib/server/http";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const passwordSchema = z
  .string()
  .min(12, "Use uma senha com pelo menos 12 caracteres.")
  .max(128);
const credentials = z
  .object({
    email: z
      .string()
      .trim()
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    password: passwordSchema,
    name: z.string().trim().min(2).max(80).optional(),
  })
  .strict();
const sessionDuration = 7 * 86400000;
type Context = {
  params: Promise<{
    action: string;
  }>;
};
function clearCookie() {
  const response = json({ ok: true });
  response.cookies.set(cookieName, "", {
    ...sessionCookieOptions,
    maxAge: 0,
  });
  return response;
}
export async function GET(request: NextRequest, context: Context) {
  return endpoint(async () => {
    if ((await context.params).action !== "me")
      throw new HttpError(404, "Não encontrado.");
    return json({ user: await currentUser(request) });
  });
}
export async function POST(request: NextRequest, context: Context) {
  return endpoint(async () => {
    originCheck(request);
    const { action } = await context.params;
    if (action === "logout") {
      const value = request.cookies.get(cookieName)?.value;
      if (value)
        await db()
          .prepare("DELETE FROM sessions WHERE hash=?")
          .run(digest(value));
      return clearCookie();
    }
    if (action === "password" || action === "delete") {
      const user = await requireUser(request);
      if (!(await rateLimit(`reauth:${user.id}`, 5, 15 * 60000)))
        throw new HttpError(429, "Aguarde 15 minutos para tentar novamente.");
      const input = await body(
        request,
        z
          .object({
            password: z.string().max(128),
            newPassword: passwordSchema.optional(),
          })
          .strict(),
      );
      const row = (await db()
        .prepare("SELECT password FROM users WHERE id=?")
        .get(user.id)) as {
        password: string;
      };
      if (!(await verifyPassword(input.password, row.password)))
        throw new HttpError(401, "Senha incorreta.");
      if (action === "delete") {
        const sender = (await db()
          .prepare("SELECT desired FROM whatsapp_service LIMIT 1")
          .get()) as
          | {
              desired: number;
            }
          | undefined;
        const admins = (await db()
          .prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin'")
          .get()) as {
          count: number;
        };
        if (user.role === "admin" && admins.count === 1 && sender?.desired)
          throw new HttpError(
            409,
            "Desconecte o WhatsApp do FastBus antes de excluir o último administrador.",
          );
        await db().prepare("DELETE FROM users WHERE id=?").run(user.id);
      } else {
        if (!input.newPassword)
          throw new HttpError(400, "Informe a nova senha.");
        const hash = await hashPassword(input.newPassword);
        await transaction(async () => {
          await db()
            .prepare(
              "UPDATE users SET password=?,must_change_password=0 WHERE id=?",
            )
            .run(hash, user.id);
          await db()
            .prepare("DELETE FROM sessions WHERE user_id=?")
            .run(user.id);
        });
      }
      return clearCookie();
    }
    if (action !== "login" && action !== "register")
      throw new HttpError(404, "Não encontrado.");
    // Deliberately do not trust spoofable forwarded headers for authentication limits.
    if (!(await rateLimit("auth:global", 60, 15 * 60000)))
      throw new HttpError(429, "Muitas tentativas. Aguarde 15 minutos.");
    const input = await body(request, credentials);
    const index = emailIndex(input.email);
    if (!(await rateLimit(`auth:${index}`, 8, 15 * 60000)))
      throw new HttpError(429, "Muitas tentativas. Aguarde 15 minutos.");
    let user = (await db()
      .prepare("SELECT id,password FROM users WHERE email_hash=?")
      .get(index)) as
      | {
          id: string;
          password: string;
        }
      | undefined;
    if (action === "register") {
      if (!input.name) throw new HttpError(400, "Informe seu nome.");
      if (process.env.FASTBUS_ALLOW_REGISTRATION !== "true")
        throw new HttpError(
          403,
          "Novos cadastros estão desativados neste servidor.",
        );
      const hash = await hashPassword(input.password);
      if (user)
        throw new HttpError(400, "Não foi possível cadastrar com estes dados.");
      const id = randomUUID();
      const inserted = await db()
        .prepare(
          "INSERT INTO users(id,email_hash,profile,password,created_at) VALUES (?,?,?,?,?) ON CONFLICT(email_hash) DO NOTHING",
        )
        .run(
          id,
          index,
          seal({ name: input.name, email: input.email }, id),
          hash,
          Date.now(),
        );
      if (!inserted.changes)
        throw new HttpError(400, "Não foi possível cadastrar com estes dados.");
      user = { id, password: hash };
    } else {
      const fallback =
        "scrypt$00000000000000000000000000000000$" + "00".repeat(64);
      const valid = await verifyPassword(
        input.password,
        user?.password || fallback,
      );
      if (!user || !valid)
        throw new HttpError(401, "E-mail ou senha incorretos.");
    }
    const value = token();
    await transaction(async () => {
      await db()
        .prepare("DELETE FROM sessions WHERE expires_at<=?")
        .run(Date.now());
      await db()
        .prepare("INSERT INTO sessions(hash,user_id,expires_at) VALUES (?,?,?)")
        .run(digest(value), user!.id, Date.now() + sessionDuration);
      await db()
        .prepare(
          "DELETE FROM sessions WHERE user_id=? AND hash NOT IN (SELECT hash FROM sessions WHERE user_id=? ORDER BY expires_at DESC LIMIT 5)",
        )
        .run(user!.id, user!.id);
    });
    const response = json({ ok: true });
    response.cookies.set(cookieName, value, {
      ...sessionCookieOptions,
      maxAge: sessionDuration / 1000,
    });
    return response;
  });
}
