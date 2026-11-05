import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";

export type RemoteWhatsAppState = {
  status:
    | "connecting"
    | "qr"
    | "authenticated"
    | "ready"
    | "saved"
    | "error"
    | "fixture";
  stable: boolean;
  qr?: string;
  qrExpires?: number;
  error?: string;
};
export type WhatsAppOperations = {
  state(): RemoteWhatsAppState;
  number(phone: string): Promise<{ _serialized: string } | null>;
  send(to: string, text: string): Promise<void>;
  checkpoint(): Promise<void>;
  stop(revoke: boolean): Promise<void>;
};

/** Job-scoped WhatsApp operations only: no SQL, arbitrary URLs, shell, or filesystem API. */
export function daytonaHandler(
  secret: string,
  operations: WhatsAppOperations,
  stopped: () => void,
) {
  if (!/^[a-f0-9]{64}$/.test(secret)) throw new Error("INVALID_JOB_SECRET");
  const sends = new Map<string, { body: string; result: Promise<void> }>();
  let lookups = 0;
  return async (req: IncomingMessage, res: ServerResponse) => {
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(value));
    };
    const credential = Buffer.from(req.headers.authorization || "");
    const expected = Buffer.from(`Bearer ${secret}`);
    if (
      credential.length !== expected.length ||
      !timingSafeEqual(credential, expected)
    ) {
      reply(401, { error: "UNAUTHORIZED" });
      return;
    }
    try {
      if (req.method === "GET" && req.url === "/state") {
        reply(200, operations.state());
        return;
      }
      if (
        req.method !== "POST" ||
        !["/number", "/send", "/checkpoint", "/stop"].includes(req.url || "")
      ) {
        reply(404, { error: "NOT_FOUND" });
        return;
      }
      let raw = "";
      for await (const chunk of req) {
        raw += chunk.toString();
        if (Buffer.byteLength(raw) > 12000) {
          reply(413, { error: "BODY_TOO_LARGE" });
          return;
        }
      }
      const body = JSON.parse(raw || "{}");
      if (req.url === "/number") {
        const { phone } = z
          .object({ phone: z.string().regex(/^\d{8,15}$/) })
          .strict()
          .parse(body);
        if (++lookups > 30) {
          reply(429, { error: "JOB_LIMIT" });
          return;
        }
        reply(200, { recipient: await operations.number(phone) });
      } else if (req.url === "/send") {
        const input = z
          .object({
            id: z.string().uuid(),
            to: z.string().regex(/^\d{8,15}@c\.us$/),
            text: z.string().min(1).max(3000),
          })
          .strict()
          .parse(body);
        const fingerprint = JSON.stringify([input.to, input.text]);
        let entry = sends.get(input.id);
        if (entry && entry.body !== fingerprint) {
          reply(409, { error: "REQUEST_CHANGED" });
          return;
        }
        if (!entry) {
          if (sends.size >= 10) {
            reply(429, { error: "JOB_LIMIT" });
            return;
          }
          entry = {
            body: fingerprint,
            result: Promise.resolve().then(() =>
              operations.send(input.to, input.text),
            ),
          };
          sends.set(input.id, entry);
        }
        await entry.result;
        reply(200, { accepted: true });
      } else if (req.url === "/checkpoint") {
        z.object({}).strict().parse(body);
        await operations.checkpoint();
        reply(200, { saved: true });
      } else {
        const { revoke } = z
          .object({ revoke: z.boolean().optional() })
          .strict()
          .parse(body);
        await operations.stop(!!revoke);
        reply(200, { stopped: true });
        stopped();
      }
    } catch (error) {
      const code =
        error instanceof z.ZodError || error instanceof SyntaxError
          ? "INVALID_REQUEST"
          : error instanceof Error && /^[A-Z_]{1,70}$/.test(error.message)
            ? error.message
            : "WHATSAPP_OPERATION_FAILED";
      reply(code === "INVALID_REQUEST" ? 400 : 503, { error: code });
    }
  };
}
