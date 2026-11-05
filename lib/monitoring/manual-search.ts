import { comparableCents } from "../money";
import { randomUUID } from "node:crypto";
import { db, transaction, rateLimit } from "../server/database";
import { seal, unseal } from "../server/crypto";
import { HttpError } from "../server/http";
import { today, type MonitorConfig } from "./schema";
import { matches, safePurchaseUrl, type Query } from "./engine";
import { providerSpacing, providerBackoff } from "./pacing";
import { diagnosticCode } from "./diagnostics";
import type { ManualSearch, SearchTarget } from "../../types/manual-search";

type Payload = Pick<ManualSearch, "config" | "targets" | "trips">;
type Row = {
  id: string;
  user_id: string;
  payload: string;
  state: ManualSearch["state"];
  code: string;
  created_at: number;
  updated_at: number;
};
export async function finishSearch(id: string, code: string) {
  await db()
    .prepare(
      "UPDATE search_jobs SET state='partial',code=?,updated_at=? WHERE id=? AND state IN ('queued','running')",
    )
    .run(code, Date.now(), id);
}
async function expire() {
  await db()
    .prepare(
      "UPDATE search_jobs SET state='partial',code='JOB_EXPIRED',updated_at=? WHERE state IN ('queued','running') AND updated_at<?",
    )
    .run(Date.now(), Date.now() - 5 * 60000);
  await db()
    .prepare("DELETE FROM search_jobs WHERE created_at<?")
    .run(Date.now() - 7 * 86400000);
}
export async function listSearches(userId: string) {
  await expire();
  const rows = (await db()
    .prepare(
      "SELECT * FROM search_jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 8",
    )
    .all(userId)) as Row[];
  const gates = (await db()
    .prepare("SELECT id,next_at FROM providers")
    .all()) as { id: string; next_at: number }[];
  return rows.map((row) => {
    const payload = unseal<Payload>(row.payload, row.id);
    return {
      id: row.id,
      ...payload,
      targets: payload.targets.map((target) => ({
        ...target,
        nextAt: gates.find((g) => g.id === target.provider)?.next_at || 0,
      })),
      state: row.state,
      code: row.code,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } satisfies ManualSearch;
  });
}
export async function enqueueSearch(
  userId: string,
  input: { config: MonitorConfig } | { id: string },
) {
  await expire();
  return transaction(async () => {
    if (
      await db()
        .prepare(
          "SELECT id FROM search_jobs WHERE user_id=? AND state IN ('queued','running') LIMIT 1",
        )
        .get(userId)
    )
      throw new HttpError(409, "Você já tem uma busca em andamento.");
    let payload: Payload, id: string;
    if ("id" in input) {
      const row = (await db()
        .prepare("SELECT * FROM search_jobs WHERE id=? AND user_id=?")
        .get(input.id, userId)) as Row | undefined;
      if (!row) throw new HttpError(404, "Busca não encontrada.");
      if (row.created_at < Date.now() - 86400000)
        throw new HttpError(
          409,
          "Inicie uma nova busca para atualizar as datas e os critérios.",
        );
      payload = unseal<Payload>(row.payload, row.id);
      id = row.id;
      if (!payload.targets.some((t) => t.state === "pending"))
        throw new HttpError(
          409,
          "Todas as combinações desta busca já foram consultadas.",
        );
    } else {
      id = randomUUID();
      const config = input.config;
      const targets: SearchTarget[] = [];
      for (
        let day = Date.parse(config.startDate);
        day <= Date.parse(config.endDate);
        day += 86400000
      )
        for (const provider of config.providers)
          targets.push({
            provider,
            date: new Date(day).toISOString().slice(0, 10),
            state: "pending",
          });
      payload = { config, targets, trips: [] };
    }
    const gates = (await db()
      .prepare("SELECT id,next_at FROM providers")
      .all()) as { id: string; next_at: number }[];
    if (
      !payload.targets.some(
        (t) =>
          t.state === "pending" &&
          (gates.find((g) => g.id === t.provider)?.next_at || 0) <= Date.now(),
      )
    )
      throw new HttpError(
        409,
        "As fontes selecionadas estão em pausa. Aguarde o horário indicado.",
      );
    if (!(await rateLimit(`manual-search:${userId}`, 3, 15 * 60000)))
      throw new HttpError(
        429,
        "Aguarde: até três rodadas de busca a cada 15 minutos.",
      );
    await db()
      .prepare(
        "INSERT INTO search_jobs(id,user_id,payload,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state='queued',code='QUEUED',updated_at=excluded.updated_at",
      )
      .run(id, userId, seal(payload, id), Date.now(), Date.now());
    return id;
  });
}

/** Runs under the same worker lease and durable provider gates as monitoring. */
export async function runSearchJob(
  query: Query,
  id?: string,
  deadline = Date.now() + 145000,
  ownsLease = () => true,
) {
  await expire();
  const row = (await db()
    .prepare(
      `SELECT * FROM search_jobs WHERE state='queued' ${id ? "AND id=?" : ""} ORDER BY created_at LIMIT 1`,
    )
    .get(...(id ? [id] : []))) as Row | undefined;
  if (!row) return false;
  const claimed = await db()
    .prepare(
      "UPDATE search_jobs SET state='running',code='RUNNING',updated_at=? WHERE id=? AND state='queued'",
    )
    .run(Date.now(), row.id);
  if (!claimed.changes) return false;
  const payload = unseal<Payload>(row.payload, row.id);
  let calls = 0;
  try {
    for (const target of payload.targets) {
      if (!ownsLease()) break;
      if (
        target.state !== "pending" ||
        calls >= 3 ||
        Date.now() > deadline - 95000
      )
        continue;
      if (
        !(await db()
          .prepare("SELECT id FROM search_jobs WHERE id=? AND state='running'")
          .get(row.id))
      )
        return true;
      if (target.date < today()) {
        target.state = "failed";
        target.code = "DATE_PASSED";
        continue;
      }
      const gate = (await db()
        .prepare(
          "INSERT INTO providers(id,next_at) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET next_at=excluded.next_at WHERE providers.next_at<=? RETURNING failures",
        )
        .get(target.provider, Date.now() + providerSpacing(), Date.now())) as
        { failures: number } | undefined;
      if (!gate) continue;
      calls++;
      let failures = gate.failures + 1,
        nextAt = Date.now() + providerBackoff(failures);
      try {
        const response = await query(
          payload.config,
          target.provider,
          target.date,
        );
        const result = response.result;
        target.validation = result.validation;
        target.outcome = response.blockedUntil
          ? "blocked"
          : response.limited && !result.error
            ? "partial"
            : result.outcome;
        target.coverage = result.coverage;
        if (
          response.blockedUntil ||
          (result.error && result.error !== "ID_JOVEM_UNCONFIRMED")
        ) {
          target.state = "failed";
          target.code = diagnosticCode(
            new Error(result.error || "PROVIDER_BLOCKED"),
          );
          nextAt = Math.max(nextAt, response.blockedUntil || 0);
        } else {
          failures = 0;
          nextAt = Date.now() + providerSpacing();
          target.state = "complete";
          target.code =
            result.error ||
            (response.limited ||
            result.validation?.state === "partial" ||
            result.coverage?.partial
              ? "PROVIDER_PARTIAL"
              : result.resultados.length
                ? "PROVIDER_OK"
                : "PROVIDER_EMPTY");
          if (result.disponivel && !result.error)
            for (const item of result.resultados.slice(0, 100)) {
              const url = safePurchaseUrl(
                item.linkCompra || result.siteUrl,
                target.provider,
              );
              if (
                !url ||
                url.length > 2048 ||
                !matches(item, payload.config) ||
                payload.trips.length >= 300
              )
                continue;
              payload.trips.push({
                departureAt: item.departureAt,
                providerTripId: item.providerTripId,
                evidence: item.evidence,
                id: randomUUID(),
                provider: target.provider,
                date: target.date,
                company: String(item.empresa || target.provider).slice(0, 160),
                departure: String(item.horario || "").slice(0, 10),
                arrival: String(item.chegada || "").slice(0, 10),
                duration: String(item.duracao || "").slice(0, 30),
                cabin: String(item.classe || "").slice(0, 80),
                price: comparableCents(item)! / 100,
                priceMinor: comparableCents(item)!,
                benefit: item.tipoGratuidade || "nenhuma",
                seats: Math.max(0, item.vagasIdJovem || 0),
                url,
              });
            }
        }
      } catch (error) {
        target.state = "failed";
        target.code = diagnosticCode(error);
      }
      await db()
        .prepare("UPDATE providers SET failures=?,next_at=? WHERE id=?")
        .run(failures, nextAt, target.provider);
      await db()
        .prepare(
          "UPDATE search_jobs SET payload=?,updated_at=? WHERE id=? AND state='running'",
        )
        .run(seal(payload, row.id), Date.now(), row.id);
    }
    const partial = payload.targets.some(
      (t) => t.state !== "complete" || t.code === "PROVIDER_PARTIAL",
    );
    await db()
      .prepare(
        "UPDATE search_jobs SET payload=?,state=?,code=?,updated_at=? WHERE id=? AND state='running'",
      )
      .run(
        seal(payload, row.id),
        partial ? "partial" : "complete",
        partial ? "SEARCH_PARTIAL" : "SEARCH_COMPLETE",
        Date.now(),
        row.id,
      );
  } catch {
    await finishSearch(row.id, "QUERY_FAILED");
  }
  return true;
}
