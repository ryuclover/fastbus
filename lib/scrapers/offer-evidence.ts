import { localInstant } from "./travel-time";
import { originZone } from "./location-zone";
import { createHash } from "node:crypto";
import type { ResultItem, OfferEvidence } from "./types";
import { brlCents } from "../money";

export function offerEvidence(
  item: ResultItem,
  provider: string,
  date: string,
  observedAt: number,
  route?: { origin: string; destination: string },
): OfferEvidence {
  const origin = item.originStop ?? {
    city: item.origem ?? route?.origin ?? null,
    terminal: null,
    id: null,
  };
  const destination = item.destinationStop ?? {
    city: item.destino ?? route?.destination ?? null,
    terminal: null,
    id: null,
  };
  const timeZone = originZone(route?.origin ?? origin.city);
  const departureAt =
    item.departureAt ?? localInstant(date, item.horario, timeZone);
  const quotedMinor =
    item.valorNumerico === undefined ? null : brlCents(item.valorNumerico);
  const id = createHash("sha256")
    .update(
      JSON.stringify([
        provider,
        item.providerTripId,
        date,
        origin,
        destination,
        item.horario,
        item.chegada,
        item.empresa,
        item.classe,
        item.tipoGratuidade,
        item.linkCompra,
        quotedMinor,
      ]),
    )
    .digest("hex");
  const kind =
    provider === "Guanabara"
      ? "seat-map"
      : provider === "ClickBus"
        ? "checkout-quota"
        : provider === "Embarca"
          ? "provider-quota"
          : null;
  return {
    linkScope:
      provider === "ClickBus" &&
      !!item.providerTripId &&
      !!item.linkCompra &&
      new URLSearchParams(item.linkCompra.split("?")[1]).get("tripId") ===
        item.providerTripId
        ? "trip"
        : "route",
    routeEvidence:
      item.segments?.length &&
      item.originStop?.city &&
      item.destinationStop?.city
        ? "provider"
        : item.originStop?.terminal || item.destinationStop?.terminal
          ? "mixed"
          : "request",
    version: 1,
    id,
    provider,
    sourceTripId: item.providerTripId ?? null,
    observedAt,
    expiresAt: Math.min(
      observedAt + 86400000,
      departureAt ?? Infinity,
      item.validUntil ?? Infinity,
    ),
    departureAt,
    arrivalAt:
      item.arrivalAt ??
      (item.arrivalDate
        ? localInstant(
            item.arrivalDate,
            item.chegada,
            originZone(route?.destination ?? destination.city),
          )
        : null),
    timeZone,
    origin,
    destination,
    segments: item.segments ?? null,
    currency: "BRL",
    quotedMinor,
    fareMinor: item.fareMinor ?? null,
    feesMinor: item.feesMinor ?? null,
    totalMinor: item.totalMinor ?? null,
    benefitEvidence:
      kind &&
      item.tipoGratuidade &&
      item.tipoGratuidade !== "nenhuma" &&
      item.vagasIdJovem &&
      item.vagasIdJovem > 0
        ? {
            kind,
            seats: item.vagasIdJovem,
            percentage: item.tipoGratuidade === "id_jovem_100" ? 100 : 50,
          }
        : null,
  };
}
