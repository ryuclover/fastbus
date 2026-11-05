import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "./database";

// Only registered application requests use the configured database. Standalone
// scraper tools can resolve a city without loading production credentials.
const application = new AsyncLocalStorage<boolean>();
export function withLocationMappings<T>(action: () => T) {
  return application.run(true, action);
}

export async function mappedCity(
  provider: string,
  key: string,
  lookup: () => Promise<string>,
) {
  if (!application.getStore()) return lookup();
  const version = 1;
  const ttl = 6 * 3600000;
  const row = (await db()
    .prepare(
      "SELECT slug FROM location_mappings WHERE provider=? AND city_key=? AND scope='city' AND version=? AND verified_at>?",
    )
    .get(provider, key, version, Date.now() - ttl)) as
    { slug: string } | undefined;
  if (row && (row.slug === key || row.slug === key + "-todos")) return row.slug;
  const slug = await lookup();
  if (slug !== key && slug !== key + "-todos")
    throw new Error("LOCATION_NOT_FOUND");
  await db()
    .prepare(
      "INSERT INTO location_mappings(provider,city_key,scope,slug,version,verified_at) VALUES(?,?,'city',?,?,?) ON CONFLICT(provider,city_key,scope) DO UPDATE SET slug=excluded.slug,version=excluded.version,verified_at=excluded.verified_at WHERE excluded.verified_at>=location_mappings.verified_at",
    )
    .run(provider, key, slug, version, Date.now());
  return slug;
}
