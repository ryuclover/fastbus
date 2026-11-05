import { cityMatches } from "./location";
import { z } from "zod";
import { offerEvidence } from "./offer-evidence";
import { brlCents, parseProviderMoney } from "../money";
import type { ScraperResult, ResultItem } from "./types";

const text = z.string().max(2048);
const count = z.number().int().nonnegative().max(1_000_000);
const stop = z.object({
  city: text.nullable(),
  id: text.nullable(),
  terminal: text.nullable(),
});
const minor = z.number().int().nonnegative().optional();
const itemSchema = z.object({
  originStop: stop.optional(),
  destinationStop: stop.optional(),
  segments: z
    .array(z.object({ origin: stop, destination: stop }))
    .max(20)
    .nullable()
    .optional(),
  fareMinor: minor,
  feesMinor: minor,
  totalMinor: minor,
  providerTripId: z.string().min(1).max(256).optional(),
  validUntil: z.number().int().positive().max(8640000000000000).optional(),
  arrivalAt: z.number().int().positive().max(8640000000000000).optional(),
  arrivalDate: z.iso.date().optional(),
  departureAt: z.number().int().positive().max(8640000000000000).optional(),
  empresa: z.string().trim().min(1).max(160),
  horario: text.optional(),
  chegada: text.optional(),
  duracao: text.optional(),
  valor: text.optional(),
  valorNumerico: z
    .number()
    .finite()
    .nonnegative()
    .refine((value) => brlCents(value) !== null)
    .optional(),
  classe: text.optional(),
  tipoGratuidade: z.enum(["id_jovem_100", "id_jovem_50", "nenhuma"]).optional(),
  vagasIdJovem: count.optional(),
  poltronasLivres: count.optional(),
  origem: text.optional(),
  destino: text.optional(),
  data: z.iso.date().optional(),
  linkCompra: text.optional(),
  avisoAssento: text.optional(),
});
const envelopeSchema = z.object({
  coverage: z
    .object({
      unsupportedConnections: count.optional(),
      candidates: count,
      checked: count,
      unconfirmed: count,
      partial: z.boolean(),
    })
    .refine(
      (v) =>
        v.checked <= v.candidates &&
        v.unconfirmed <= v.checked &&
        (v.checked === v.candidates || v.partial),
    )
    .optional(),
  disponivel: z.boolean(),
  vagasIdJovem: count,
  detalhes: text,
  siteUrl: text,
  empresa: text.optional(),
  provedor: text,
  dataConsultada: z.iso.date().optional(),
  resultados: z.array(z.unknown()).max(1000),
  error: text.optional(),
});

function outcomeFor(
  provider: string,
  error: string | undefined,
  invalid: boolean,
  partial: boolean,
  size: number,
): NonNullable<ScraperResult["outcome"]> {
  if (invalid) return "failed";
  if (error === "PROVIDER_BLOCKED" || error === "HTTP_429") return "blocked";
  if (
    error === "MANUAL_ONLY" ||
    (error === "ID_JOVEM_UNCONFIRMED" && provider === "AguiaBranca")
  )
    return "manual";
  if (error === "ID_JOVEM_UNCONFIRMED") return "partial";
  if (error) return "failed";
  if (provider === "Gontijo") return "manual";
  if (partial) return "partial";
  return size ? "offers" : "empty";
}

/** Validates adapter output without inventing missing prices, seats or benefits. */
export function validateProviderResult(
  input: unknown,
  provider: string,
  date: string,
  observedAt: number,
  route?: { origin: string; destination: string },
): ScraperResult {
  const parsed = envelopeSchema.safeParse(input);
  const failure = (): ScraperResult => ({
    disponivel: false,
    vagasIdJovem: 0,
    detalhes: "Resposta inválida do provedor",
    siteUrl: "",
    provedor: provider,
    dataConsultada: date,
    resultados: [],
    outcome: "failed",
    error: "PROVIDER_INVALID_RESPONSE",
    validation: {
      version: 1,
      observedAt,
      received: null,
      accepted: 0,
      rejected: 0,
      state: "invalid",
    },
  });
  if (!parsed.success) return failure();
  const value = parsed.data;
  if (
    value.provedor !== provider ||
    (value.dataConsultada && value.dataConsultada !== date)
  )
    return failure();
  const resultados: ResultItem[] = [];
  for (const raw of value.resultados) {
    const item = itemSchema.safeParse(raw);
    if (!item.success) continue;
    if (item.data.tipoGratuidade?.startsWith("id_jovem")) {
      const service = item.data.classe
        ?.trim()
        .split(/\s*\(/)[0]
        ?.trim()
        .toLowerCase();
      if (
        (service !== "convencional" && service !== "conv") ||
        !item.data.vagasIdJovem ||
        item.data.valorNumerico == null ||
        (route &&
          route.origin.split("::")[1] === route.destination.split("::")[1])
      )
        continue;
    }
    const { fareMinor, feesMinor, totalMinor } = item.data;
    if (
      totalMinor != null &&
      ((fareMinor ?? 0) > totalMinor ||
        (feesMinor ?? 0) > totalMinor ||
        (fareMinor != null &&
          feesMinor != null &&
          fareMinor + feesMinor !== totalMinor))
    )
      continue;
    if (
      item.data.tipoGratuidade === "id_jovem_100" &&
      fareMinor != null &&
      fareMinor !== 0
    )
      continue;
    if (route) {
      const pairs = [
        [item.data.originStop?.city ?? item.data.origem, route.origin],
        [
          item.data.destinationStop?.city ?? item.data.destino,
          route.destination,
        ],
      ] as const;
      if (
        pairs.some(([reported, expected]) => {
          const [city, state] = expected.split("::");
          return reported && !cityMatches(reported, city, state);
        })
      )
        continue;
    }
    if (!item.data.data || item.data.data === date) {
      const evidence = offerEvidence(
        item.data,
        provider,
        date,
        observedAt,
        route,
      );
      if (
        evidence.arrivalAt != null &&
        evidence.departureAt != null &&
        evidence.arrivalAt < evidence.departureAt
      )
        continue;
      const normalized = {
        ...item.data,
        evidence,
        departureAt: evidence.departureAt ?? undefined,
      };
      const price = item.data.valorNumerico;
      resultados.push(
        price === undefined
          ? normalized
          : {
              ...normalized,
              priceMinor:
                item.data.totalMinor ??
                parseProviderMoney(price) ??
                Math.round(price * 100),
            },
      );
    }
  }
  const rejected = value.resultados.length - resultados.length;
  const invalid = rejected > 0 && resultados.length === 0;
  return {
    ...value,
    outcome: outcomeFor(
      provider,
      value.error,
      invalid,
      rejected > 0 || !!value.coverage?.partial,
      resultados.length,
    ),
    resultados,
    disponivel:
      value.disponivel && resultados.length > 0 && !value.error && !invalid,
    vagasIdJovem: resultados.reduce(
      (sum, item) => sum + (item.vagasIdJovem ?? 0),
      0,
    ),
    error: invalid ? "PROVIDER_INVALID_RESPONSE" : value.error,
    validation: {
      version: 1,
      observedAt,
      received: value.resultados.length,
      accepted: resultados.length,
      rejected,
      state: invalid ? "invalid" : rejected ? "partial" : "valid",
    },
  };
}
