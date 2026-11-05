import type { AlertPayload } from "./engine";
import { localInstant } from "../scrapers/travel-time";
import { originZone } from "../scrapers/location-zone";
import { brlCents } from "../money";

export function alertIsCurrent(payload: AlertPayload, now = Date.now()) {
  const evidence = payload.evidence;
  const departure =
    payload.departureAt ??
    evidence?.departureAt ??
    localInstant(payload.date, payload.departure, originZone(payload.origin));
  const expires = Math.min(
    departure ?? 0,
    payload.observedAt + 86400000,
    evidence?.expiresAt ?? Infinity,
  );
  if (!Number.isFinite(expires) || expires <= now || payload.observedAt > now)
    return false;
  const price = brlCents(payload.price);
  if (
    price === null ||
    (payload.priceMinor !== undefined && payload.priceMinor !== price)
  )
    return false;
  if (
    evidence &&
    (evidence.provider !== payload.provider ||
      (evidence.totalMinor ?? evidence.quotedMinor) !== price)
  )
    return false;
  if (payload.benefit === "nenhuma") return true;
  const from = payload.origin.split("::")[1],
    to = payload.destination.split("::")[1];
  return (
    !!from &&
    !!to &&
    from !== to &&
    !!evidence?.benefitEvidence &&
    evidence.benefitEvidence.seats > 0 &&
    evidence.benefitEvidence.percentage ===
      (payload.benefit === "id_jovem_100"
        ? 100
        : payload.benefit === "id_jovem_50"
          ? 50
          : 0)
  );
}
