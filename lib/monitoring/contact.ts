import { z } from "zod";
import { db } from "../server/database";
import { unseal } from "../server/crypto";
export const phoneSchema = z
  .string()
  .trim()
  .max(30)
  .regex(/^[+\d ()-]+$/, "Informe somente o número com código do país.")
  .transform((value) => value.replace(/[ ()-]/g, ""))
  .refine(
    (value) => /^\+[1-9]\d{7,14}$/.test(value),
    "Use o formato internacional: +55, DDD e número.",
  );
export const contactSchema = z
  .object({
    phone: phoneSchema,
    enabled: z.boolean(),
    consent: z.literal(true, {
      error: "Confirme que o número é seu e que aceita receber os alertas.",
    }),
  })
  .strict();
export async function getContact(userId: string) {
  const row = (await db()
    .prepare(
      "SELECT c.phone,c.enabled,v.status AS verification_status,v.expires_at FROM notification_contacts c LEFT JOIN contact_verifications v ON v.user_id=c.user_id AND v.phone=c.phone WHERE c.user_id=?",
    )
    .get(userId)) as
    | {
        phone: string;
        enabled: number;
        verification_status: string | null;
        expires_at: number | null;
      }
    | undefined;
  return row
    ? {
        phone: unseal<string>(row.phone, `contact:${userId}`),
        enabled: !!row.enabled && row.verification_status === "verified",
        verified: row.verification_status === "verified",
        verificationStatus:
          row.verification_status !== "verified" &&
          row.expires_at &&
          row.expires_at <= Date.now()
            ? "expired"
            : row.verification_status || "unverified",
        expiresAt:
          row.verification_status !== "verified" ? row.expires_at : null,
      }
    : {
        phone: "",
        enabled: false,
        verified: false,
        verificationStatus: "unverified",
        expiresAt: null,
      };
}
