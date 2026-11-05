import { reportedDate } from "../location";
import { z } from "zod";
import { brlCents } from "../../money";
import { ResultItem, ScraperResult } from "../types";
import { fetchWithRetry } from "../../http-client";
import {
  currentMonitoringBudget,
  remainingMonitoringRequests,
} from "../../monitoring/request-budget";

const seatCursors = new Map<string, number>();

function formatarSlugGuanabara(cidade: string): string {
  return cidade
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function formatarCidadeGuanabaraApi(cidade: string, uf: string): string {
  const limpo = cidade
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
  return `${limpo} - ${uf.toUpperCase()} - TODOS`;
}

const money = z
  .number()
  .nonnegative()
  .refine((value) => brlCents(value) !== null);
const label = z.string().max(512).nullish();
const stop = z
  .object({ date_time: label, location: label, address: label })
  .nullish();
const offsetTimestamp = z.iso.datetime({ offset: true });
function departureInstant(raw: string | null | undefined) {
  if (!raw || !offsetTimestamp.safeParse(raw).success) return undefined;
  const milliseconds = Date.parse(raw);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}
const tripSchema = z.object({
  trip_id: z.number().int().positive().nullish(),
  fare: money.nullish(),
  total: money.nullish(),
  original_price: money.nullish(),
  boarding_fee: money.nullish(),
  sub_total: money.nullish(),
  passenger_classification_id: z.number().int().nullish(),
  company: label,
  class_of_service: label,
  route_duration: label,
  origin: stop,
  destination: stop,
  routes: z
    .array(
      z.object({
        daily_schedule_route_id: z.number().int().positive().nullish(),
        available_seats: z.number().int().nonnegative().nullish(),
        class_of_service_name: label,
        company_name: label,
      }),
    )
    .max(100)
    .nullish(),
});

function parseTrips(input: unknown) {
  const envelope = z
    .object({ trips: z.array(z.unknown()).max(1000) })
    .safeParse(input);
  if (!envelope.success) throw new Error("PROVIDER_INVALID_RESPONSE");
  const trips: z.infer<typeof tripSchema>[] = [];
  for (const raw of envelope.data.trips) {
    const trip = tripSchema.safeParse(raw);
    if (trip.success) trips.push(trip.data);
  }
  const rejected = envelope.data.trips.length - trips.length;
  if (rejected && !trips.length) throw new Error("PROVIDER_INVALID_RESPONSE");
  return { trips, rejected };
}

function parseSeatQuotas(input: unknown) {
  const response = z
    .object({
      passengerTypeAvailability: z
        .array(
          z.object({
            name: z.string().max(160),
            available_seats: z.number().int().nonnegative(),
          }),
        )
        .max(100),
    })
    .safeParse(input);
  if (!response.success) return null;
  const quotas = new Map<string, number>();
  for (const entry of response.data.passengerTypeAvailability) {
    const name = entry.name.trim().toLowerCase();
    const percentage = /(?:^|[^0-9])(100|50)\s*%/.exec(name)?.[1];
    if (
      !percentage ||
      (!/^(?:100|50)\s*%$/.test(name) && !/\bjovem\b/.test(name))
    )
      continue;
    if (quotas.has(percentage)) return null;
    quotas.set(percentage, entry.available_seats);
  }
  return quotas.size
    ? { j100: quotas.get("100") ?? 0, j50: quotas.get("50") ?? 0 }
    : null;
}

export async function fetchGuanabaraDirect(
  origem: string,
  origemUF: string,
  destino: string,
  destinoUF: string,
  data: string, // YYYY-MM-DD
  idJovem = false,
): Promise<ScraperResult> {
  const origemSlug = formatarSlugGuanabara(origem);
  const destinoSlug = formatarSlugGuanabara(destino);
  const origemApi = formatarCidadeGuanabaraApi(origem, origemUF);
  const destinoApi = formatarCidadeGuanabaraApi(destino, destinoUF);

  const siteUrlBase = `https://viajeguanabara.com.br/onibus/${origemSlug}-${origemUF.toLowerCase()}-todos/${destinoSlug}-${destinoUF.toLowerCase()}-todos/?departure_date=${data}`;
  const siteUrl = `${siteUrlBase}&passengers=${idJovem ? "13:1" : "1"}`;

  const headers = {
    Accept: "application/json, text/plain, */*",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    Referer: siteUrl,
  };

  try {
    const resultados: ResultItem[] = [];
    let totalVagasIdJovem = 0;
    let unconfirmed = false;
    let candidatesCount = 0;
    let checked = 0;
    let inconclusive = 0;
    let unsupportedConnections = 0;

    if (idJovem) {
      // Consulta oficial ID Jovem Guanabara (Beneficiários ID Jovem = passenger_classification_id: 13)
      // O endpoint passengers=13:1 retorna tanto vagas com 100% de gratuidade (fare = 0)
      // quanto vagas com 50% de desconto estatutário (fare > 0).
      const resp = await fetchWithRetry(
        `https://viajeguanabara.com.br/api/search/services/?departure_date=${data}&destination=${encodeURIComponent(
          destinoApi,
        )}&origin=${encodeURIComponent(origemApi)}&passengers=13:1`,
        { headers, timeoutMs: 6000 },
        1,
      );

      if (!resp.ok)
        throw new Error(
          resp.status === 404
            ? "COVERAGE_NOT_IMPLEMENTED"
            : `HTTP_${resp.status}`,
        );

      if (resp && resp.ok) {
        try {
          const parsed = parseTrips(await resp.json());
          const trips = parsed.trips.filter(
            (t) => (t.routes?.length ?? 0) <= 1,
          );
          unsupportedConnections = parsed.trips.length - trips.length;
          candidatesCount = parsed.trips.length + parsed.rejected;
          checked = parsed.rejected + unsupportedConnections;
          inconclusive = checked;
          unconfirmed = inconclusive > 0;

          // Consultar poucos mapas por rodada, em série, sem repetir uma mesma viagem.
          // A Guanabara frequentemente exibe fare: 0 no card de busca, mas ao clicar no assento recalcula o valor.
          const realSeatsMap = new Map<number, { j100: number; j50: number }>();
          try {
            const candidates = [
              ...new Map(
                trips.map((t) => [
                  t.routes?.[0]?.daily_schedule_route_id || t.trip_id,
                  t,
                ]),
              ).values(),
            ];
            const offset = seatCursors.get(siteUrl) || 0;
            const batch = Array.from(
              {
                length: Math.min(
                  6,
                  candidates.length,
                  remainingMonitoringRequests(),
                ),
              },
              (_, i) => candidates[(offset + i) % candidates.length],
            );
            if (batch.length < candidates.length) {
              unconfirmed = true;
              const budget = currentMonitoringBudget();
              if (budget) budget.limited = true;
            }
            let attempted = 0;
            for (const t of batch) {
              if (
                currentMonitoringBudget()?.blockedUntil ||
                !remainingMonitoringRequests()
              )
                break;
              const rId = t.routes?.[0]?.daily_schedule_route_id || t.trip_id;
              if (!rId) continue;
              attempted++;
              const sResp = await fetchWithRetry(
                "https://viajeguanabara.com.br/api/seats/maps/",
                {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    "User-Agent": headers["User-Agent"],
                    Referer: siteUrl,
                  },
                  body: JSON.stringify({
                    id_daily_schedule_route: rId,
                    id_passenger_classification_list: [13],
                    id_passenger_type: 7,
                  }),
                  timeoutMs: 3000,
                },
                1,
              ).catch(() => null);

              if (sResp && sResp.ok) {
                const sJson = await sResp.json().catch(() => null);
                const quotas = parseSeatQuotas(sJson);
                if (!quotas) {
                  unconfirmed = true;
                  continue;
                }
                const { j100, j50 } = quotas;
                realSeatsMap.set(rId, { j100, j50 });
              } else unconfirmed = true;
            }
            seatCursors.delete(siteUrl);
            seatCursors.set(
              siteUrl,
              candidates.length ? (offset + attempted) % candidates.length : 0,
            );
            if (seatCursors.size > 100)
              seatCursors.delete(seatCursors.keys().next().value!);
          } catch {
            unconfirmed = true;
            // Em caso de falha de conexão na API de assentos, segue com dados do card
          }

          for (const t of trips) {
            const empresa =
              t.company || t.routes?.[0]?.company_name || "Guanabara";
            const classe =
              t.class_of_service ||
              t.routes?.[0]?.class_of_service_name ||
              undefined;
            const vagas = t.routes?.[0]?.available_seats ?? undefined;

            const horarioPartida =
              t.origin?.date_time?.split("T")[1]?.slice(0, 5) || "N/A";
            const horarioChegada =
              t.destination?.date_time?.split("T")[1]?.slice(0, 5) || "N/A";
            const duracao = t.route_duration
              ? t.route_duration.slice(0, 5).replace(":", "h ") + "m"
              : "Direto";

            const rId = t.routes?.[0]?.daily_schedule_route_id || t.trip_id;
            const seatQuota = rId ? realSeatsMap.get(rId) : null;
            if (!seatQuota) {
              unconfirmed = true;
              continue;
            }
            checked++;
            if (!seatQuota.j100 && !seatQuota.j50) continue;
            if (
              !classe ||
              classe.trim().toLowerCase() !== "convencional" ||
              (t.passenger_classification_id != null &&
                t.passenger_classification_id !== 13) ||
              (t.routes?.length ?? 0) > 1
            ) {
              inconclusive++;
              unconfirmed = true;
              continue;
            }

            // The search card and the seat map describe the same route. Only
            // advertise a benefit when the base fare also confirms its value.
            const precoConfirmado = t.total;
            if (
              precoConfirmado == null ||
              t.fare == null ||
              precoConfirmado < t.fare
            ) {
              inconclusive++;
              unconfirmed = true;
              continue;
            }
            const full =
              t.fare === 0 &&
              seatQuota.j100 > 0 &&
              precoConfirmado === (t.boarding_fee ?? 0);
            const half =
              t.fare > 0 &&
              seatQuota.j50 > 0 &&
              t.passenger_classification_id === 13 &&
              t.original_price != null &&
              Math.round(t.fare * 100) * 2 ===
                Math.round(t.original_price * 100);
            if (!full && !half) {
              inconclusive++;
              unconfirmed = true;
              continue;
            }
            const tipo = full ? "id_jovem_100" : "id_jovem_50";
            const vagasConfirmadas =
              tipo === "id_jovem_100" ? seatQuota.j100 : seatQuota.j50;
            totalVagasIdJovem += vagasConfirmadas;
            resultados.push({
              empresa,
              horario: horarioPartida,
              chegada: horarioChegada,
              duracao,
              valor: `R$ ${precoConfirmado.toFixed(2).replace(".", ",")}`,
              valorNumerico: precoConfirmado,
              classe,
              tipoGratuidade: tipo,
              vagasIdJovem: vagasConfirmadas,
              poltronasLivres: vagas,
              origem: `${origem} - ${origemUF}`,
              destino: `${destino} - ${destinoUF}`,
              data: reportedDate(
                t.origin?.date_time,
                data,
                origem + "::" + origemUF,
              ),
              originStop: {
                city: origem + "::" + origemUF,
                terminal: t.origin?.location ?? null,
                id: null,
              },
              destinationStop: {
                city: destino + "::" + destinoUF,
                terminal: t.destination?.location ?? null,
                id: null,
              },
              fareMinor:
                t.fare == null ? undefined : (brlCents(t.fare) ?? undefined),
              feesMinor:
                t.boarding_fee == null
                  ? undefined
                  : (brlCents(t.boarding_fee) ?? undefined),
              totalMinor:
                t.total == null ? undefined : (brlCents(t.total) ?? undefined),
              departureAt: departureInstant(t.origin?.date_time),
              arrivalAt: departureInstant(t.destination?.date_time),
              arrivalDate: t.destination?.date_time?.slice(0, 10),
              linkCompra: `${siteUrlBase}&passengers=13:1`,
              providerTripId: String(rId),
            });
          }
        } catch {
          throw new Error("PROVIDER_INVALID_RESPONSE");
        }
      }
    } else {
      // Modo Geral: Consulta normal com passengers=1
      const resp = await fetchWithRetry(
        `https://viajeguanabara.com.br/api/search/services/?departure_date=${data}&destination=${encodeURIComponent(
          destinoApi,
        )}&origin=${encodeURIComponent(origemApi)}&passengers=1`,
        { headers, timeoutMs: 5000 },
        1,
      );

      if (!resp.ok)
        throw new Error(
          resp.status === 404
            ? "COVERAGE_NOT_IMPLEMENTED"
            : `HTTP_${resp.status}`,
        );

      if (resp && resp.ok) {
        const parsed = parseTrips(await resp.json());
        const trips = parsed.trips.filter((t) => (t.routes?.length ?? 0) <= 1);
        unsupportedConnections = parsed.trips.length - trips.length;
        candidatesCount = parsed.trips.length + parsed.rejected;
        checked = parsed.rejected + unsupportedConnections;
        inconclusive = checked;
        unconfirmed = inconclusive > 0;

        for (const t of trips) {
          checked++;
          const empresa =
            t.company || t.routes?.[0]?.company_name || "Guanabara";
          const classe =
            t.class_of_service ||
            t.routes?.[0]?.class_of_service_name ||
            undefined;
          const vagas = t.routes?.[0]?.available_seats ?? undefined;

          const horarioPartida =
            t.origin?.date_time?.split("T")[1]?.slice(0, 5) || "N/A";
          const horarioChegada =
            t.destination?.date_time?.split("T")[1]?.slice(0, 5) || "N/A";
          const duracao = t.route_duration
            ? t.route_duration.slice(0, 5).replace(":", "h ") + "m"
            : "Direto";
          const preco = t.total;
          if (
            typeof preco !== "number" ||
            !Number.isFinite(preco) ||
            preco < 0
          ) {
            inconclusive++;
            unconfirmed = true;
            continue;
          }

          resultados.push({
            empresa,
            horario: horarioPartida,
            chegada: horarioChegada,
            duracao,
            valor: `R$ ${preco.toFixed(2).replace(".", ",")}`,
            valorNumerico: preco,
            classe,
            providerTripId: t.trip_id ? String(t.trip_id) : undefined,
            tipoGratuidade: "nenhuma",
            vagasIdJovem: 0,
            poltronasLivres: vagas,
            origem: `${origem} - ${origemUF}`,
            destino: `${destino} - ${destinoUF}`,
            data: reportedDate(
              t.origin?.date_time,
              data,
              origem + "::" + origemUF,
            ),
            originStop: {
              city: origem + "::" + origemUF,
              terminal: t.origin?.location ?? null,
              id: null,
            },
            destinationStop: {
              city: destino + "::" + destinoUF,
              terminal: t.destination?.location ?? null,
              id: null,
            },
            fareMinor:
              t.fare == null ? undefined : (brlCents(t.fare) ?? undefined),
            feesMinor:
              t.boarding_fee == null
                ? undefined
                : (brlCents(t.boarding_fee) ?? undefined),
            totalMinor:
              t.total == null ? undefined : (brlCents(t.total) ?? undefined),
            departureAt: departureInstant(t.origin?.date_time),
            arrivalAt: departureInstant(t.destination?.date_time),
            arrivalDate: t.destination?.date_time?.slice(0, 10),
            linkCompra: `${siteUrlBase}&passengers=1`,
          });
        }
      }
    }

    const disponivel = resultados.length > 0;

    return {
      disponivel,
      coverage: {
        ...(unsupportedConnections ? { unsupportedConnections } : {}),
        candidates: candidatesCount,
        checked,
        unconfirmed: inconclusive,
        partial: unconfirmed || checked < candidatesCount,
      },
      vagasIdJovem: totalVagasIdJovem,
      detalhes: disponivel
        ? `${resultados.length} opção(ões) na plataforma Guanabara (${resultados.map((r) => r.empresa).join(", ")})`
        : unconfirmed
          ? "Não foi possível confirmar todas as ofertas nesta rodada."
          : "Nenhuma oferta confirmada pela Guanabara para esta data.",
      siteUrl,
      empresa: "Guanabara",
      provedor: "Guanabara",
      dataConsultada: data,
      resultados,
      error:
        idJovem && unconfirmed && !resultados.length
          ? "ID_JOVEM_UNCONFIRMED"
          : undefined,
    };
  } catch (error: any) {
    return {
      disponivel: false,
      vagasIdJovem: 0,
      detalhes: `Erro ao consultar Guanabara: ${error?.message || error}`,
      siteUrl,
      empresa: "Guanabara",
      provedor: "Guanabara",
      dataConsultada: data,
      resultados: [],
      error: error?.message || String(error),
    };
  }
}
