import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, rateLimit } from "./database";
import { digest, unseal } from "./crypto";
import type { User } from "../../types/account";
export type { User } from "../../types/account";
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const cookieName =
  process.env.NODE_ENV === "production" ? "__Host-fastbus" : "fastbus";
export const sessionCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  path: "/",
} as const;
export function originCheck(request: NextRequest) {
  const origin =
    process.env.APP_ORIGIN ||
    (process.env.VERCEL_PROJECT_PRODUCTION_URL
      ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
      : "http://localhost:3000");
  if (process.env.NODE_ENV === "production" && !origin.startsWith("https://"))
    throw new HttpError(503, "Configure a origem HTTPS do serviço.");
  if (
    request.headers.get("origin") !== origin ||
    request.headers.get("sec-fetch-site") === "cross-site"
  ) {
    throw new HttpError(403, "Origem da requisição não permitida.");
  }
}
export async function body<T>(
  request: NextRequest,
  schema: z.ZodType<T>,
): Promise<T> {
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new HttpError(415, "Envie JSON.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Corpo ausente.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.length;
    if (size > 16384) {
      await reader.cancel();
      throw new HttpError(413, "Requisição muito grande.");
    }
    chunks.push(chunk.value);
  }
  try {
    return schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) {
    if (error instanceof z.ZodError) throw error;
    throw new HttpError(400, "JSON inválido.");
  }
}
export async function currentUser(request: NextRequest): Promise<User | null> {
  const value = request.cookies.get(cookieName)?.value;
  if (!value || !/^[a-f0-9]{64}$/.test(value)) return null;
  const row = (await db()
    .prepare(
      `SELECT u.id,u.profile,u.role,u.must_change_password FROM sessions s JOIN users u ON s.user_id=u.id
    WHERE s.hash=? AND s.expires_at>?`,
    )
    .get(digest(value), Date.now())) as
    | {
        id: string;
        profile: string;
        role: "user" | "admin";
        must_change_password: number;
      }
    | undefined;
  return row
    ? {
        id: row.id,
        ...unseal<{
          name: string;
          email: string;
        }>(row.profile, row.id),
        role: row.role,
        mustChangePassword: !!row.must_change_password,
      }
    : null;
}
export async function requireUser(request: NextRequest): Promise<User> {
  const user = await currentUser(request);
  if (!user) throw new HttpError(401, "Entre na sua conta para continuar.");
  if (!(await rateLimit(`api:${user.id}`, 180, 60000)))
    throw new HttpError(429, "Aguarde um minuto antes de tentar novamente.");
  return user;
}
export async function requireAdmin(request: NextRequest): Promise<User> {
  const user = await requireUser(request);
  if (user.role !== "admin")
    throw new HttpError(403, "Acesso restrito ao administrador.");
  if (user.mustChangePassword)
    throw new HttpError(
      403,
      "Troque sua senha inicial na área Conta antes de acessar a administração.",
    );
  return user;
}
export function json(data: unknown, status = 200) {
  return NextResponse.json(data, {
    status,
    headers: {
      "Cache-Control": "no-store",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
export async function endpoint(fn: () => Promise<NextResponse> | NextResponse) {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return json(
        { error: error.issues[0]?.message || "Dados inválidos." },
        400,
      );
    console.error(
      "[FastBus API]",
      error instanceof Error ? error.name : "Erro interno",
    );
    return json(
      {
        error:
          "Não foi possível concluir a operação. Verifique a configuração do serviço.",
      },
      500,
    );
  }
}
