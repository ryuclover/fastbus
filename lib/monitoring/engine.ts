import { brlCents, comparableCents } from "../money";
import { localInstant } from "../scrapers/travel-time";
import { originZone } from "../scrapers/location-zone";
import { alertIsCurrent } from "./alert-validity";
import { locationKey } from "../scrapers/location";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { db, transaction } from "../server/database";
import { digest, seal, unseal } from "../server/crypto";
import { today, type MonitorConfig, type MonitorRow } from "./schema";
import type { ResultItem, ScraperResult } from "../scrapers/types";
import { monitorSpacing, providerSpacing, providerBackoff } from "./pacing";
import { supportsMonitoring, capabilityMessage } from "./capabilities";
import { diagnosticCode } from "./diagnostics";
export type AlertPayload = {
  evidence?: import("../scrapers/types").OfferEvidence;
  departureAt?: number;
  priceMinor?: number;
  providerTripId?: string;
  origin: string;
  destination: string;
  date: string;
  departure: string;
  company: string;
  provider: string;
  price: number;
  benefit: string;
  url: string;
  observedAt: number;
};
const sourceDomains: Record<string, string[]> = {
  ClickBus: ["clickbus.com.br"],
  Guanabara: ["viajeguanabara.com.br"],
  Buser: ["buser.com.br"],
  Gontijo: ["gontijo.com.br"],
  Embarca: ["embarca.ai"],
  AguiaBranca: ["aguiabranca.com.br"],
  Mobifacil: ["mobifacil.com.br"],
};
export function safePurchaseUrl(
  value: string | undefined,
  provider: string,
): string | null {
  try {
    const url = new URL(value || "");
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      (sourceDomains[provider] || []).some(
        (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
      )
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}
export function matches(
  item: ResultItem,
  config: MonitorConfig,
  now = Date.now(),
) {
  if (item.departureAt !== undefined && item.departureAt <= now) return false;
  for (const [requested, reported] of [
    [
      config.originTerminal,
      item.evidence?.origin.terminal ?? item.originStop?.terminal,
    ],
    [
      config.destinationTerminal,
      item.evidence?.destination.terminal ?? item.destinationStop?.terminal,
    ],
  ]) {
    if (
      requested &&
      (!reported || locationKey(requested) !== locationKey(reported))
    )
      return false;
  }
  if (item.evidence && item.evidence.expiresAt <= now) return false;
  const cents = comparableCents(item),
    cap = brlCents(config.maxPrice);
  if (cents === null || cap === null || cents > cap) return false;
  if (
    (config.benefit !== "any" || item.tipoGratuidade?.startsWith("id_jovem")) &&
    config.origin.split("::")[1] === config.destination.split("::")[1]
  )
    return false;
  if (config.benefit === "any") return true;
  if (!item.vagasIdJovem || item.vagasIdJovem < 1) return false;
  return config.benefit === "id100"
    ? item.tipoGratuidade === "id_jovem_100"
    : ["id_jovem_100", "id_jovem_50"].includes(item.tipoGratuidade || "");
}
export function targetFor(config: MonitorConfig, cursor: number) {
  const providers = config.providers.filter((provider) =>
    supportsMonitoring(provider, config.benefit),
  );
  if (!providers.length) return null;
  const start = config.rollingWindow
    ? today()
    : config.startDate < today()
      ? today()
      : config.startDate;
  const end = config.rollingWindow
    ? new Date(Date.parse(start) + 13 * 86400000).toISOString().slice(0, 10)
    : config.endDate;
  if (start > end) return null;
  const days = Math.floor((Date.parse(end) - Date.parse(start)) / 86400000) + 1;
  const index = cursor % (days * providers.length);
  if (config.rollingWindow) {
    // Rotate absolute calendar slots: advancing both the clock and a relative
    // offset skipped alternate departures when the worker ran once a day.
    const day = Math.floor(Date.parse(start) / 86400000);
    const anchor = Math.floor(Date.parse(config.startDate) / 86400000);
    const slot = (anchor + Math.floor(cursor / providers.length)) % 14;
    const offset = (slot - (day % 14) + 14) % 14;
    return {
      provider: providers[index % providers.length],
      date: new Date((day + offset) * 86400000).toISOString().slice(0, 10),
    };
  }
  return {
    provider: providers[index % providers.length],
    date: new Date(
      Date.parse(start) + Math.floor(index / providers.length) * 86400000,
    )
      .toISOString()
      .slice(0, 10),
  };
}
export async function recordResult(
  monitor: MonitorRow,
  config: MonitorConfig,
  provider: string,
  date: string,
  result: ScraperResult,
) {
  // Unavailable/error responses must never be interpreted as confirmed availability.
  if (result.error || !result.disponivel) return false;
  const candidates = result.resultados
    .filter(
      (item) =>
        (item.departureAt ??
          localInstant(date, item.horario, originZone(config.origin)) ??
          0) > Date.now() &&
        matches(item, config) &&
        safePurchaseUrl(item.linkCompra || result.siteUrl, provider),
    )
    .sort((a, b) => comparableCents(a)! - comparableCents(b)!);
  const best = candidates[0];
  if (!best) return false;
  const priceMinor = comparableCents(best)!;
  const fingerprint = digest(
    JSON.stringify([
      provider,
      date,
      best.empresa,
      best.horario,
      best.classe,
      best.tipoGratuidade,
    ]),
  );
  return await transaction(async () => {
    const owner = (await db()
      .prepare("SELECT active,config FROM monitors WHERE id=? AND user_id=?")
      .get(monitor.id, monitor.user_id)) as
      | {
          active: number;
          config: string;
        }
      | undefined;
    if (!owner?.active || owner.config !== monitor.config) return false;
    const previous = (await db()
      .prepare(
        "SELECT o.price, p.price_minor FROM observations o LEFT JOIN observation_prices p USING(monitor_id,fingerprint) WHERE o.monitor_id=? AND o.fingerprint=?",
      )
      .get(monitor.id, fingerprint)) as
      | {
          price: number;
          price_minor: number | null;
        }
      | undefined;
    // Notify on first detection or a meaningful price drop, never on the same offer repeatedly.
    const priorMinor =
      previous?.price_minor ?? (previous ? brlCents(previous.price) : null);
    if (
      priorMinor !== null &&
      (priceMinor >= priorMinor || priceMinor * 100 > priorMinor * 97)
    )
      return false;
    const id = randomUUID();
    const payload: AlertPayload = {
      departureAt:
        best.departureAt ??
        localInstant(date, best.horario, originZone(config.origin)) ??
        undefined,
      providerTripId: best.providerTripId,
      evidence: best.evidence,
      origin: config.origin,
      destination: config.destination,
      date,
      departure: best.horario || "Consulte a fonte",
      company: best.empresa,
      provider,
      price: priceMinor / 100,
      priceMinor,
      benefit: best.tipoGratuidade || "nenhuma",
      url: safePurchaseUrl(best.linkCompra || result.siteUrl, provider)!,
      observedAt: best.evidence?.observedAt ?? Date.now(),
    };
    await db()
      .prepare(
        "INSERT INTO observations(monitor_id,fingerprint,price) VALUES (?,?,?) ON CONFLICT(monitor_id,fingerprint) DO UPDATE SET price=excluded.price",
      )
      .run(monitor.id, fingerprint, payload.price);
    await db()
      .prepare(
        "INSERT INTO observation_prices(monitor_id,fingerprint,price_minor) VALUES(?,?,?) ON CONFLICT(monitor_id,fingerprint) DO UPDATE SET price_minor=excluded.price_minor",
      )
      .run(monitor.id, fingerprint, priceMinor);
    await db()
      .prepare(
        "INSERT INTO alerts(id,user_id,monitor_id,payload,next_at,created_at) VALUES (?,?,?,?,?,?)",
      )
      .run(
        id,
        monitor.user_id,
        monitor.id,
        seal(payload, id),
        Date.now(),
        Date.now(),
      );
    return true;
  });
}
export type Query = (
  config: MonitorConfig,
  provider: MonitorConfig["providers"][number],
  date: string,
) => Promise<{
  result: ScraperResult;
  blockedUntil?: number;
  limited?: boolean;
}>;
export async function runOneQuery(query: Query) {
  const rows = (await db()
    .prepare(
      "SELECT * FROM monitors WHERE active=1 AND next_at<=? ORDER BY next_at LIMIT 100",
    )
    .all(Date.now())) as MonitorRow[];
  for (const monitor of rows) {
    const config = unseal<MonitorConfig>(monitor.config, monitor.id);
    if (!targetFor(config, monitor.cursor)) {
      await db()
        .prepare("UPDATE monitors SET active=0,status=? WHERE id=?")
        .run(
          config.providers.some((p) => supportsMonitoring(p, config.benefit))
            ? "Período encerrado"
            : capabilityMessage,
          monitor.id,
        );
      continue;
    }
    const reservation = await transaction(async () => {
      const now = Date.now();
      let earliest = Infinity;
      const count = config.providers.filter((p) =>
        supportsMonitoring(p, config.benefit),
      ).length;
      for (let offset = 0; offset < count; offset++) {
        const cursor = monitor.cursor + offset;
        const candidate = targetFor(config, cursor);
        if (!candidate) break;
        const gate = (await db()
          .prepare(
            "INSERT INTO providers(id,next_at) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET next_at=excluded.next_at WHERE providers.next_at<=? RETURNING failures",
          )
          .get(candidate.provider, now + providerSpacing(), now)) as
          { failures: number } | undefined;
        if (gate) {
          const next =
            process.env.FASTBUS_CLOUD_MODE === "daily"
              ? Date.parse(new Date(now + 86400000).toISOString().slice(0, 10))
              : now + monitorSpacing(config.intervalMinutes);
          await db()
            .prepare("UPDATE monitors SET next_at=? WHERE id=?")
            .run(next, monitor.id);
          return { target: candidate, cursor, failures: gate.failures };
        }
        const paused = (await db()
          .prepare("SELECT next_at FROM providers WHERE id=?")
          .get(candidate.provider)) as { next_at: number };
        earliest = Math.min(earliest, paused.next_at);
      }
      if (Number.isFinite(earliest))
        await db()
          .prepare(
            "UPDATE monitors SET next_at=?,status='Aguardando intervalo da fonte' WHERE id=?",
          )
          .run(earliest, monitor.id);
      return null;
    });
    if (!reservation) continue;
    const { target } = reservation;
    let status: string;
    let code = "QUERY_FAILED";
    const runId = randomUUID();
    await db()
      .prepare(
        "INSERT INTO query_runs(id,monitor_id,provider,travel_date,started_at,code) VALUES (?,?,?,?,?,'RUNNING')",
      )
      .run(runId, monitor.id, target.provider, target.date, Date.now());
    let failures = 0;
    let nextProviderAt = Date.now() + providerSpacing();
    try {
      const response = await query(config, target.provider, target.date);
      const unconfirmed = response.result.error === "ID_JOVEM_UNCONFIRMED";
      const error =
        (!!response.result.error && !unconfirmed) || !!response.blockedUntil;
      if (error) {
        failures = reservation.failures + 1;
        nextProviderAt = Math.max(
          response.blockedUntil || 0,
          Date.now() + providerBackoff(failures),
        );
        code = /^[A-Z][A-Z0-9_]{0,79}$/.test(response.result.error || "")
          ? response.result.error!
          : "QUERY_FAILED";
        status = `Fonte indisponível: ${target.provider} (${code}). Nova tentativa após a pausa.`;
      } else {
        code = unconfirmed ? "ID_JOVEM_UNCONFIRMED" : "OK";
        const found = await recordResult(
          monitor,
          config,
          target.provider,
          target.date,
          response.result,
        );
        status = unconfirmed
          ? `${target.provider}: consulta concluída; cota ID Jovem online não confirmada. Nenhum aviso gerado.`
          : found
            ? `Oportunidade encontrada em ${target.provider}; aviso salvo`
            : `${target.provider}: nenhuma nova oferta nos critérios`;
        if (response.limited) status += " (consulta parcial)";
        if (target.provider === "Gontijo")
          status = "Gontijo: sem confirmação automática de disponibilidade";
      }
    } catch (error) {
      code = diagnosticCode(error);
      failures = reservation.failures + 1;
      nextProviderAt = Date.now() + providerBackoff(failures);
      status = `Falha na consulta a ${target.provider} (${code}); nova tentativa agendada`;
    }
    await db()
      .prepare("UPDATE query_runs SET completed_at=?,code=? WHERE id=?")
      .run(Date.now(), code, runId);
    await db()
      .prepare("DELETE FROM query_runs WHERE started_at<?")
      .run(Date.now() - 30 * 86400000);
    await db()
      .prepare("UPDATE providers SET next_at=?,failures=? WHERE id=?")
      .run(nextProviderAt, failures, target.provider);
    await db()
      .prepare(
        "UPDATE monitors SET cursor=?,checked_at=?,status=? WHERE id=? AND active=1 AND config=?",
      )
      .run(
        reservation.cursor + 1,
        Date.now(),
        status,
        monitor.id,
        monitor.config,
      );
    return true;
  }
  return false;
}
export class DeliveryUncertain extends Error {}

export async function deliverOne(
  send: (userId: string, payload: AlertPayload) => Promise<boolean>,
) {
  await db()
    .prepare(
      "UPDATE alerts SET status='uncertain' WHERE status='in_flight' AND next_at<=?",
    )
    .run(Date.now());
  const row = (await db()
    .prepare(
      `SELECT a.* FROM alerts a JOIN monitors m ON m.id=a.monitor_id
    WHERE a.status='pending' AND a.next_at<=? AND m.active=1 ORDER BY a.next_at LIMIT 1`,
    )
    .get(Date.now())) as
    | {
        id: string;
        user_id: string;
        payload: string;
        attempts: number;
      }
    | undefined;
  if (!row) return false;
  const payload = unseal<AlertPayload>(row.payload, row.id);
  // Stale opportunities remain visible in history, but must not trigger a late WhatsApp message.
  if (!alertIsCurrent(payload)) {
    await db()
      .prepare(
        "UPDATE alerts SET status='expired' WHERE id=? AND status='pending'",
      )
      .run(row.id);
    return true;
  }
  const reserved = await db()
    .prepare(
      "UPDATE alerts SET status='in_flight',next_at=? WHERE id=? AND status='pending' AND next_at<=? AND EXISTS(SELECT 1 FROM monitors m WHERE m.id=alerts.monitor_id AND m.active=1)",
    )
    .run(Date.now() + 10 * 60000, row.id, Date.now());
  if (!reserved.changes) return false;
  let sent: boolean;
  try {
    sent = await send(row.user_id, payload);
  } catch (error) {
    const attempts = row.attempts + 1;
    const status =
      error instanceof DeliveryUncertain
        ? "uncertain"
        : attempts >= 6
          ? "failed"
          : "pending";
    await db()
      .prepare(
        "UPDATE alerts SET attempts=?,status=?,next_at=? WHERE id=? AND status='in_flight'",
      )
      .run(
        attempts,
        status,
        Date.now() + Math.min(360, 2 ** attempts) * 60000,
        row.id,
      );
    return true;
  }
  if (sent) {
    await db()
      .prepare(
        "UPDATE alerts SET status='sent',sent_at=? WHERE id=? AND status='in_flight'",
      )
      .run(Date.now(), row.id);
    return "sent";
  }
  const current = alertIsCurrent(payload);
  await db()
    .prepare(
      "UPDATE alerts SET status=?,next_at=? WHERE id=? AND status='in_flight'",
    )
    .run(current ? "pending" : "expired", Date.now() + 60000, row.id);
  return current ? "deferred" : true;
}
/** Remove stale items in one pass so they cannot consume the daily send slot. */
export async function expireAlerts() {
  await db()
    .prepare(
      "UPDATE alerts SET status='expired' WHERE status='pending' AND created_at<?",
    )
    .run(Date.now() - 24 * 3600000);
}
export async function drainAlerts(
  send: (userId: string, payload: AlertPayload) => Promise<boolean>,
  deadline = Date.now() + 30000,
  maxItems = 20,
) {
  await expireAlerts();
  await db()
    .prepare(
      `UPDATE alerts SET next_at=? WHERE status='pending' AND next_at<=? AND NOT EXISTS(
    SELECT 1 FROM notification_contacts c JOIN contact_verifications v ON v.user_id=c.user_id AND v.phone=c.phone
    WHERE c.user_id=alerts.user_id AND c.enabled=1 AND v.status='verified')`,
    )
    .run(Date.now() + 60000, Date.now());
  for (let i = 0; i < maxItems && Date.now() < deadline; i++) {
    const result = await deliverOne(send);
    if (!result) break;
    if (result === "sent" && i + 1 < maxItems) {
      if (deadline - Date.now() < 5000) break;
      await delay(5000);
    }
  }
}
