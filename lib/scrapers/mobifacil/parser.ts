import { z } from "zod";
import { parseProviderMoney } from "../../money";

/** Accepted source formats: JSON number, decimal dot, or Brazilian decimal comma. */
export function mobifacilPrice(value: unknown): number | null {
  const cents = parseProviderMoney(value, "Mobifacil");
  return cents === null ? null : cents / 100;
}

const text = z.string().max(2048).optional();
const serviceSchema = z.object({
  preco: z
    .union([z.number(), z.string()])
    .transform(mobifacilPrice)
    .refine((v) => v !== null),
  saida: text,
  chegada: text,
  duration: text,
  empresa: text,
  classe: text,
  originName: text,
  destinationName: text,
  poltronasLivres: z.number().int().nonnegative().optional(),
});
export type MobifacilService = z.infer<typeof serviceSchema>;
export type ParsedServices =
  | {
      state: "valid" | "partial";
      services: MobifacilService[];
      received: number;
      rejected: number;
    }
  | {
      state: "invalid";
      services: [];
      received: number | null;
      rejected: number;
    };

export function parseMobifacilServices(html: string): ParsedServices {
  const invalid = (): ParsedServices => ({
    state: "invalid",
    services: [],
    received: null,
    rejected: 0,
  });
  const decoded = html
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
  const marker = /"lsServicos"\s*:\s*/g;
  const match = marker.exec(decoded);
  if (!match) return invalid();
  const start = marker.lastIndex;
  if (decoded[start] !== "[") return invalid();
  let depth = 0,
    inString = false,
    escaped = false;
  for (let i = start; i < decoded.length; i++) {
    const c = decoded[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[") depth++;
    else if (c === "]" && --depth === 0) {
      let raw: unknown;
      try {
        raw = JSON.parse(decoded.slice(start, i + 1));
      } catch {
        return invalid();
      }
      if (!Array.isArray(raw) || raw.length > 1000) return invalid();
      const services: MobifacilService[] = [];
      for (const value of raw) {
        const parsed = serviceSchema.safeParse(value);
        if (parsed.success) services.push(parsed.data);
      }
      const rejected = raw.length - services.length;
      if (rejected && !services.length)
        return {
          state: "invalid",
          services: [],
          received: raw.length,
          rejected,
        };
      return {
        state: rejected ? "partial" : "valid",
        services,
        received: raw.length,
        rejected,
      };
    }
  }
  return invalid();
}
