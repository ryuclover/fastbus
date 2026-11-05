import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { db, transaction, rateLimit } from "../server/database";
import { seal, unseal, emailIndex } from "../server/crypto";
import { getContact } from "./contact";
import { serviceId } from "../server/whatsapp-service";
import type { AlertTransport } from "./whatsapp";

export class VerificationError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const hashCode = (id: string, user: string, phone: string, code: string) =>
  emailIndex(`verification:${id}:${user}:${phone}:${code}`);
export async function requestContact(
  userId: string,
  phone: string,
  enabled: boolean,
) {
  const current = await getContact(userId);
  if (!enabled || (current.phone === phone && current.verified)) {
    if (current.phone !== phone)
      throw new VerificationError(
        400,
        "Confirme o novo número antes de ativar ou pausar os avisos.",
      );
    await db()
      .prepare(
        "UPDATE notification_contacts SET enabled=?,updated_at=? WHERE user_id=?",
      )
      .run(enabled ? 1 : 0, Date.now(), userId);
    return { verificationRequired: false };
  }
  const now = Date.now();
  if (
    !(await rateLimit(`otp:request:user:${userId}`, 3, 3600000)) ||
    !(await rateLimit(`otp:request:phone:${emailIndex(phone)}`, 3, 3600000))
  )
    throw new VerificationError(
      429,
      "Aguarde uma hora antes de solicitar outro código (máximo de três envios).",
    );
  const id = randomUUID();
  const code = String(randomInt(0, 10000)).padStart(4, "0");
  const encryptedPhone = seal(phone, `contact:${userId}`);
  await transaction(async () => {
    await db()
      .prepare(
        `INSERT INTO notification_contacts(user_id,phone,enabled,consent_at,updated_at) VALUES (?,?,0,?,?)
      ON CONFLICT(user_id) DO UPDATE SET phone=excluded.phone,enabled=0,consent_at=excluded.consent_at,updated_at=excluded.updated_at`,
      )
      .run(userId, encryptedPhone, now, now);
    await db()
      .prepare(
        `INSERT INTO contact_verifications(user_id,id,phone,code_hash,code,status,attempts,expires_at,created_at) VALUES (?,?,?,?,?,'pending',0,?,?)
      ON CONFLICT(user_id) DO UPDATE SET id=excluded.id,phone=excluded.phone,code_hash=excluded.code_hash,code=excluded.code,status='pending',attempts=0,expires_at=excluded.expires_at,created_at=excluded.created_at,sent_at=NULL`,
      )
      .run(
        userId,
        id,
        encryptedPhone,
        hashCode(id, userId, phone, code),
        seal(code, `verification:${id}`),
        now + 10 * 60000,
        now,
      );
  });
  return { verificationRequired: true, challengeId: id };
}

export async function confirmContact(userId: string, code: string) {
  if (!(await rateLimit(`otp:attempt:${userId}`, 10, 3600000)))
    throw new VerificationError(429, "Muitas tentativas. Aguarde uma hora.");
  const outcome = await transaction(async () => {
    const row = (await db()
      .prepare(
        "SELECT v.* FROM contact_verifications v JOIN notification_contacts c ON c.user_id=v.user_id AND c.phone=v.phone WHERE v.user_id=?",
      )
      .get(userId)) as
      | {
          id: string;
          phone: string;
          code_hash: string | null;
          status: string;
          attempts: number;
          expires_at: number;
        }
      | undefined;
    if (
      !row ||
      row.status !== "sent" ||
      row.expires_at <= Date.now() ||
      row.attempts >= 5 ||
      !row.code_hash
    )
      return false;
    const phone = unseal<string>(row.phone, `contact:${userId}`);
    const valid = timingSafeEqual(
      Buffer.from(row.code_hash),
      Buffer.from(hashCode(row.id, userId, phone, code)),
    );
    if (!valid) {
      await db()
        .prepare(
          "UPDATE contact_verifications SET attempts=attempts+1,code_hash=CASE WHEN attempts>=4 THEN NULL ELSE code_hash END,status=CASE WHEN attempts>=4 THEN 'locked' ELSE status END WHERE user_id=?",
        )
        .run(userId);
      return false;
    }
    await db()
      .prepare(
        "UPDATE contact_verifications SET status='verified',code_hash=NULL,code=NULL WHERE user_id=?",
      )
      .run(userId);
    await db()
      .prepare(
        "UPDATE notification_contacts SET enabled=1,updated_at=? WHERE user_id=?",
      )
      .run(Date.now(), userId);
    return true;
  });
  if (!outcome)
    throw new VerificationError(
      400,
      "Código inválido, expirado ou ainda não enviado. Verifique o WhatsApp ou solicite outro código.",
    );
}

export async function deliverVerification(transport: AlertTransport) {
  await db()
    .prepare(
      "UPDATE contact_verifications SET status='expired',code=NULL,code_hash=NULL WHERE status IN ('pending','sending','sent') AND expires_at<=?",
    )
    .run(Date.now());
  const sender = (await db()
    .prepare("SELECT desired FROM whatsapp_service WHERE id=?")
    .get(serviceId)) as { desired: number } | undefined;
  if (!sender?.desired) return false;
  const row = (await db()
    .prepare(
      "SELECT v.* FROM contact_verifications v JOIN notification_contacts c ON c.user_id=v.user_id AND c.phone=v.phone WHERE v.status='pending' AND v.expires_at>? ORDER BY v.created_at LIMIT 1",
    )
    .get(Date.now())) as
    { id: string; user_id: string; phone: string; code: string } | undefined;
  if (!row) return false;
  const phone = unseal<string>(row.phone, `contact:${row.user_id}`);
  const recipient = await transport.getNumberId(phone.slice(1));
  if (!recipient?._serialized.endsWith("@c.us")) {
    await db()
      .prepare(
        "UPDATE contact_verifications SET status='failed',code=NULL,code_hash=NULL WHERE id=? AND status='pending'",
      )
      .run(row.id);
    return false;
  }
  const reserved = await transaction(async () => {
    const stillDesired = (await db()
      .prepare("SELECT desired FROM whatsapp_service WHERE id=?")
      .get(serviceId)) as { desired: number } | undefined;
    if (!stillDesired?.desired) return false;
    for (const key of [
      "sender:global",
      `recipient:${emailIndex(`recipient:${phone}`)}`,
    ]) {
      const gate = (await db()
        .prepare("SELECT next_at FROM outbound_gates WHERE key=?")
        .get(key)) as { next_at: number } | undefined;
      if (gate && gate.next_at > Date.now()) return false;
    }
    const claimed = await db()
      .prepare(
        "UPDATE contact_verifications SET status='sending',code=NULL WHERE id=? AND user_id=? AND status='pending' AND expires_at>? AND EXISTS(SELECT 1 FROM notification_contacts c WHERE c.user_id=contact_verifications.user_id AND c.phone=contact_verifications.phone)",
      )
      .run(row.id, row.user_id, Date.now());
    if (!claimed.changes) return false;
    for (const key of [
      "sender:global",
      `recipient:${emailIndex(`recipient:${phone}`)}`,
    ])
      await db()
        .prepare(
          "INSERT INTO outbound_gates(key,next_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET next_at=excluded.next_at",
        )
        .run(key, Date.now() + (key === "sender:global" ? 5000 : 60000));
    return true;
  });
  if (!reserved) return false;
  try {
    const code = unseal<string>(row.code, `verification:${row.id}`);
    await transport.sendMessage(
      recipient._serialized,
      `FastBus • confirmação do seu WhatsApp\nSeu código é: ${code}\nDigite estes 4 dígitos no site para ativar seus avisos. Válido por 10 minutos. Não compartilhe este código. Se não solicitou, ignore esta mensagem.`,
      { linkPreview: false, waitUntilMsgSent: true },
    );
    await db()
      .prepare(
        "UPDATE contact_verifications SET status='sent',sent_at=?,expires_at=? WHERE id=? AND status='sending'",
      )
      .run(Date.now(), Date.now() + 10 * 60000, row.id);
    return true;
  } catch {
    await db()
      .prepare(
        "UPDATE contact_verifications SET status='failed',code_hash=NULL WHERE id=? AND status='sending'",
      )
      .run(row.id);
    return false;
  }
}
