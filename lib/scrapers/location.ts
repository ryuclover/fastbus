import { originZone } from "./location-zone";
import { cidadesSugeridas } from "../cidades-sugeridas";

export function locationKey(name: string) {
  return name
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\s-]+/g, "-");
}

const catalog = new Map(
  cidadesSugeridas.map(({ nome, uf }) => [
    locationKey(nome) + "-" + uf.toLowerCase(),
    { nome, uf },
  ]),
);
export function canonicalCity(city: string, state: string) {
  const key = locationKey(city) + "-" + state.trim().toLowerCase();
  return {
    key,
    ...(catalog.get(key) ?? {
      nome: city.trim(),
      uf: state.trim().toUpperCase(),
    }),
  };
}

export function cityMatches(reported: string, city: string, state: string) {
  const normalized = locationKey(reported.replace(/::|\s*\/\s*/g, "-"));
  return (
    normalized === locationKey(city) ||
    normalized === canonicalCity(city, state).key
  );
}

/** Match only an exact city/UF slug or its all-terminals equivalent. */
export function resolveExactSlug(
  candidates: unknown,
  expected: string,
): string {
  if (!Array.isArray(candidates)) throw new Error("PROVIDER_INVALID_RESPONSE");
  const matches = new Set<string>();
  const identities = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || !("slug" in candidate))
      continue;
    const slug = candidate.slug;
    const uf =
      "uf" in candidate
        ? candidate.uf
        : "state" in candidate &&
            candidate.state &&
            typeof candidate.state === "object" &&
            "code" in candidate.state
          ? candidate.state.code
          : undefined;
    if (typeof uf === "string" && !expected.endsWith("-" + uf.toLowerCase()))
      continue;
    if (
      typeof slug === "string" &&
      (slug === expected || slug === `${expected}-todos`)
    ) {
      matches.add(slug);
      if (
        "id" in candidate &&
        (typeof candidate.id === "string" || typeof candidate.id === "number")
      )
        identities.add(String(candidate.id));
    }
  }
  if (!matches.size) throw new Error("LOCATION_NOT_FOUND");
  // Both city and aggregator require an explicit terminal-scope choice.
  if (matches.size > 1 || identities.size > 1)
    throw new Error("LOCATION_AMBIGUOUS");
  return [...matches][0];
}

export function routeSlugParts(slug: string) {
  const match = /^([a-z0-9]+(?:[-_][a-z0-9]+)*)-([a-z]{2})(?:-todos)?$/.exec(
    slug,
  );
  if (!match) throw new Error("LOCATION_NOT_FOUND");
  return { city: match[1].replace(/[-_]/g, " "), uf: match[2].toUpperCase() };
}

// Preserve a supplier's explicit date. A mismatch is rejected by the registry.
export function reportedDate(
  raw: string | null | undefined,
  requested: string,
  origin?: string,
) {
  if (!raw) return requested;
  if (/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(raw) && origin) {
    const zone = originZone(origin);
    const ms = Date.parse(raw);
    if (zone && Number.isFinite(ms))
      return new Intl.DateTimeFormat("en-CA", {
        timeZone: zone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(ms);
  }
  const br = /^(\d{2})\/(\d{2})\/(\d{4})(?:\s|$)/.exec(raw);
  return br
    ? [br[3], br[2], br[1]].join("-")
    : (/^(\d{4}-\d{2}-\d{2})(?:T|\s|$)/.exec(raw)?.[1] ?? requested);
}
