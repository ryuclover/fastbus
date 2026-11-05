import { z } from "zod";
import { brlCents } from "../money";

const label = z.string().max(512);
const field = label.nullish();
const seats = z.number().int().nonnegative().nullish();
export const decimalPrice = z
  .union([z.number(), z.string().regex(/^\d+(?:\.\d{1,2})?$/)])
  .transform(Number)
  .refine((v) => brlCents(v) !== null);
const name = z.object({ name: field }).nullish();
const identifier = z
  .union([label, z.number().int()])
  .transform(String)
  .nullish();
const stop = z
  .object({
    city: field,
    state: field,
    date: z.iso.date().nullish(),
    time: field,
    name: field,
    id: identifier,
    schedule: z.object({ time: field }).nullish(),
  })
  .nullish();
const part = z.object({
  departure: stop,
  arrival: stop,
  travelCompany: name,
  serviceClass: name,
  tripId: identifier,
  availableSeats: seats,
  duration: z
    .union([
      label,
      z.object({ hours: z.union([label, z.number()]).optional() }),
    ])
    .nullish(),
});
export const clickTrip = part
  .extend({
    uuid: identifier,
    price: decimalPrice.nullish(),
    company: name,
    parts: z.array(part).max(20).nullish(),
    anttServiceClass: name,
    options: z
      .object({
        isGratuityTrip: z.boolean().optional(),
        hasGratuityCheckout: z.boolean().optional(),
      })
      .nullish(),
  })
  .refine((t) => !!(t.uuid || t.tripId || t.parts?.length || t.departure));

const quota = z.object({
  category_id: z.number().int().nullish(),
  subcategory: field,
  name: field,
  available_seats_quantity: seats,
  available: seats,
  total_price: decimalPrice.nullish(),
});
export const embarcaTrip = z
  .object({
    id: identifier,
    operator_name: field,
    operator: name,
    departure_at: field,
    arrival_at: field,
    hours: z.union([label, z.number()]).nullish(),
    minutes: z.union([label, z.number()]).nullish(),
    seat_class: field,
    group: field,
    available_seats: seats,
    price: decimalPrice.nullish(),
    gratuity_types: z
      .array(z.union([quota, label]))
      .max(100)
      .nullish(),
  })
  .refine(
    (t) => t.price != null || t.gratuity_types != null || !!t.departure_at,
  );

export const clockText = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);
export const commercialCard = z.object({
  price: decimalPrice,
  departure: clockText.optional(),
  arrival: clockText.optional(),
});

export function parseRows<T>(input: unknown, schema: z.ZodType<T>) {
  if (!Array.isArray(input) || input.length > 1000)
    throw new Error("PROVIDER_INVALID_RESPONSE");
  const rows: T[] = [];
  for (const raw of input) {
    const parsed = schema.safeParse(raw);
    if (parsed.success) rows.push(parsed.data);
  }
  const rejected = input.length - rows.length;
  if (rejected && !rows.length) throw new Error("PROVIDER_INVALID_RESPONSE");
  return { rows, rejected };
}
