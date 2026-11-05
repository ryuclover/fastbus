import { randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { db, transaction, rateLimit } from "../server/database";
import { emailIndex, seal, unseal, hashPassword } from "../server/crypto";
import { VerificationError } from "./contact-verification";
import { serviceId } from "../server/whatsapp-service";
import type { AlertTransport } from "./whatsapp";
const recoveryHash = (id: string, user: string, code: string) =>
  emailIndex(`password-recovery:${id}:${user}:${code}`);
export async function requestRecovery(email: string) {
  const index = emailIndex(email);
  if (
    !(await rateLimit("recovery:global", 20, 3600000)) ||
    !(await rateLimit(`recovery:request:${index}`, 3, 3600000))
  )
    throw new VerificationError(
      429,
      "Aguarde uma hora antes de solicitar outro código.",
    );
  const row = (await db()
    .prepare(
      `SELECT u.id,c.phone FROM users u JOIN notification_contacts c ON c.user_id=u.id
  JOIN contact_verifications v ON v.user_id=c.user_id AND v.phone=c.phone AND v.status='verified' WHERE u.email_hash=?`,
    )
    .get(index)) as { id: string; phone: string } | undefined;
  if (!row) return false;
  const number = unseal<string>(row.phone, `contact:${row.id}`);
  if (!(await rateLimit(`otp:request:phone:${emailIndex(number)}`, 3, 3600000)))
    return false;
  const id = randomUUID(),
    code = String(randomInt(0, 100000000)).padStart(8, "0");
  await db()
    .prepare(
      `INSERT INTO password_recovery(user_id,id,phone,code_hash,code,status,expires_at) VALUES (?,?,?,?,?,'pending',?)
 ON CONFLICT(user_id) DO UPDATE SET id=excluded.id,phone=excluded.phone,code_hash=excluded.code_hash,code=excluded.code,status='pending',attempts=0,expires_at=excluded.expires_at`,
    )
    .run(
      row.id,
      id,
      row.phone,
      recoveryHash(id, row.id, code),
      seal(code, `recovery:${id}`),
      Date.now() + 10 * 60000,
    );
  return true;
}
export async function resetPassword(
  email: string,
  code: string,
  password: string,
) {
  const index = emailIndex(email);
  if (!(await rateLimit(`recovery:attempt:${index}`, 10, 3600000)))
    throw new VerificationError(429, "Muitas tentativas. Aguarde uma hora.");
  const ok = await transaction(async () => {
    const row = (await db()
      .prepare(
        `SELECT r.* FROM password_recovery r JOIN users u ON u.id=r.user_id
   JOIN notification_contacts c ON c.user_id=r.user_id AND c.phone=r.phone JOIN contact_verifications v ON v.user_id=c.user_id AND v.phone=c.phone AND v.status='verified'
   WHERE u.email_hash=? AND r.status='sent' AND r.expires_at>? AND r.attempts<5`,
      )
      .get(index, Date.now())) as
      { id: string; user_id: string; code_hash: string } | undefined;
    if (!row?.code_hash) return false;
    if (
      !timingSafeEqual(
        Buffer.from(row.code_hash),
        Buffer.from(recoveryHash(row.id, row.user_id, code)),
      )
    ) {
      await db()
        .prepare(
          "UPDATE password_recovery SET attempts=attempts+1,code_hash=CASE WHEN attempts>=4 THEN NULL ELSE code_hash END WHERE id=?",
        )
        .run(row.id);
      return false;
    }
    const hash = await hashPassword(password);
    await db()
      .prepare("UPDATE users SET password=?,must_change_password=0 WHERE id=?")
      .run(hash, row.user_id);
    await db().prepare("DELETE FROM sessions WHERE user_id=?").run(row.user_id);
    await db().prepare("DELETE FROM password_recovery WHERE id=?").run(row.id);
    return true;
  });
  if (!ok) throw new VerificationError(400, "Código inválido ou expirado.");
}
export async function deliverRecovery(transport: AlertTransport) {
  await db()
    .prepare(
      "UPDATE password_recovery SET status='expired',code=NULL,code_hash=NULL WHERE expires_at<=? AND status IN ('pending','sending','sent')",
    )
    .run(Date.now());
  const sender = (await db()
    .prepare("SELECT desired FROM whatsapp_service WHERE id=?")
    .get(serviceId)) as { desired: number } | undefined;
  if (!sender?.desired) return false;
  const row = (await db()
    .prepare(
      `SELECT r.* FROM password_recovery r JOIN notification_contacts c ON c.user_id=r.user_id AND c.phone=r.phone
 JOIN contact_verifications v ON v.user_id=c.user_id AND v.phone=c.phone AND v.status='verified' WHERE r.status='pending' AND r.expires_at>? LIMIT 1`,
    )
    .get(Date.now())) as
    { id: string; user_id: string; phone: string; code: string } | undefined;
  if (!row) return false;
  const phone = unseal<string>(row.phone, `contact:${row.user_id}`);
  const recipient = await transport.getNumberId(phone.slice(1));
  if (!recipient?._serialized.endsWith("@c.us")) {
    await db()
      .prepare(
        "UPDATE password_recovery SET status='failed',code=NULL,code_hash=NULL WHERE id=?",
      )
      .run(row.id);
    return false;
  }
  const gateKeys = [
    "sender:global",
    `recipient:${emailIndex(`recipient:${phone}`)}`,
  ];
  const claimed = await transaction(async () => {
    for (const key of gateKeys) {
      const gate = (await db()
        .prepare("SELECT next_at FROM outbound_gates WHERE key=?")
        .get(key)) as { next_at: number } | undefined;
      if (gate && gate.next_at > Date.now()) return false;
    }
    const result = await db()
      .prepare(
        `UPDATE password_recovery SET status='sending',code=NULL WHERE id=? AND status='pending' AND expires_at>?
   AND EXISTS(SELECT 1 FROM notification_contacts c JOIN contact_verifications v ON v.user_id=c.user_id AND v.phone=c.phone AND v.status='verified' WHERE c.user_id=password_recovery.user_id AND c.phone=password_recovery.phone)
   AND EXISTS(SELECT 1 FROM whatsapp_service WHERE id=? AND desired=1)`,
      )
      .run(row.id, Date.now(), serviceId);
    if (!result.changes) return false;
    for (const key of gateKeys)
      await db()
        .prepare(
          "INSERT INTO outbound_gates(key,next_at) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET next_at=excluded.next_at",
        )
        .run(key, Date.now() + (key === "sender:global" ? 5000 : 60000));
    return true;
  });
  if (!claimed) return false;
  try {
    const code = unseal<string>(row.code, `recovery:${row.id}`);
    await transport.sendMessage(
      recipient._serialized,
      `FastBus • recuperação de acesso\nSeu código de recuperação é: ${code}\nDigite no site para definir uma nova senha. Válido por 10 minutos. Não compartilhe. Se não solicitou, ignore.`,
      { linkPreview: false, waitUntilMsgSent: true },
    );
    await db()
      .prepare(
        "UPDATE password_recovery SET status='sent',expires_at=? WHERE id=? AND status='sending'",
      )
      .run(Date.now() + 10 * 60000, row.id);
    return true;
  } catch {
    await db()
      .prepare(
        "UPDATE password_recovery SET status='failed',code_hash=NULL WHERE id=?",
      )
      .run(row.id);
    return false;
  }
}
