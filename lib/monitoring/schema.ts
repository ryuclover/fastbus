import { brlCents } from "../money";
import { z } from "zod";
import { supportsMonitoring, capabilityMessage } from "./capabilities";
import { cidadesSugeridas, valorCidade } from "../cidades-sugeridas";

import { providerIds } from "../../types/providers";
export { providerIds } from "../../types/providers";
const cities = new Set(cidadesSugeridas.map(valorCidade));
const city = z
  .string()
  .refine((value) => cities.has(value), "Selecione uma cidade da lista.");
export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Data inválida.")
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return (
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value
    );
  }, "Data inválida.");
export const monitorSchema = z
  .object({
    origin: city,
    destination: city,
    originTerminal: z.string().trim().min(1).max(160).optional(),
    destinationTerminal: z.string().trim().min(1).max(160).optional(),
    startDate: date,
    endDate: date,
    rollingWindow: z.literal(14).optional(),
    maxPrice: z
      .number()
      .finite()
      .min(0)
      .max(10000)
      .refine(
        (v) => brlCents(v) !== null,
        "Use no máximo duas casas decimais.",
      ),
    intervalMinutes: z.number().int().min(30).max(1440),
    benefit: z.enum(["any", "id50", "id100"]),
    providers: z
      .array(z.enum(providerIds))
      .min(1)
      .max(7)
      .transform((values) => [...new Set(values)]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.providers.some(
        (provider) => !supportsMonitoring(provider, value.benefit),
      )
    )
      ctx.addIssue({ code: "custom", message: capabilityMessage });
    if (
      process.env.FASTBUS_CLOUD_MODE === "daily" &&
      value.intervalMinutes !== 1440
    )
      ctx.addIssue({
        code: "custom",
        message:
          "Nesta instalação, as consultas são diárias. Selecione 24 horas.",
      });
    if (
      value.benefit !== "any" &&
      value.origin.split("::")[1] === value.destination.split("::")[1]
    )
      ctx.addIssue({
        code: "custom",
        message: "Para ID Jovem, selecione cidades em estados diferentes.",
      });
    const days =
      (Date.parse(value.endDate) - Date.parse(value.startDate)) / 86400000;
    if (value.origin === value.destination)
      ctx.addIssue({
        code: "custom",
        message: "Origem e destino devem ser diferentes.",
      });
    if (
      (!value.rollingWindow && value.startDate < today()) ||
      days < 0 ||
      days > (value.rollingWindow ? 13 : 6) ||
      Date.parse(value.endDate) > Date.now() + 365 * 86400000
    ) {
      ctx.addIssue({
        code: "custom",
        message:
          "Escolha até 7 dias consecutivos, entre hoje e os próximos 12 meses.",
      });
    }
    if (value.benefit !== "any" && value.providers.includes("Buser"))
      ctx.addIssue({
        code: "custom",
        message: "Buser não oferece consulta de ID Jovem.",
      });
  });
export type MonitorConfig = z.infer<typeof monitorSchema>;
export type MonitorRow = {
  id: string;
  user_id: string;
  config: string;
  active: number;
  cursor: number;
  next_at: number;
  checked_at: number | null;
  status: string;
  created_at: number;
  last_success?: number | null;
  last_error?: string | null;
};
