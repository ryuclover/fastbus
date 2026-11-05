import { clickTrip, parseRows } from "../raw-contracts";
import {
  monitoredFetch,
  remainingMonitoringRequests,
  blockMonitoringRequests,
} from "../../monitoring/request-budget";
import { ResultItem, ScraperResult } from "../types";
import { createHash, randomUUID } from "node:crypto";
import { mappedCity } from "../../server/location-mappings";
import { canonicalCity, cityMatches, resolveExactSlug } from "../location";
import {
  parseClickBusTripPage,
  isClickBusChallengeHtml,
  type ClickBusQuotas,
} from "./benefits";

const CLICKBUS_SECRET = "2a8e4222-9c42-342e-efa5-9132c8ode00e";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Mapeamento de grandes regiões metropolitanas e capitais onde a ClickBus adota o slug agregador "-todos"
const METROPOLITAN_SLUGS: Record<string, string> = {
  "sao-paulo-sp": "sao-paulo-sp-todos",
  "rio-de-janeiro-rj": "rio-de-janeiro-rj-todos",
  "belo-horizonte-mg": "belo-horizonte-mg-todos",
  "curitiba-pr": "curitiba-pr-todos",
  "campinas-sp": "campinas-sp-todos",
  "brasilia-df": "brasilia-df-todos",
  "salvador-ba": "salvador-ba-todos",
  "florianopolis-sc": "florianopolis-sc-todos",
  "porto-alegre-rs": "porto-alegre-rs-todos",
  "goiania-go": "goiania-go-todos",
  "vitoria-es": "vitoria-es-todos",
  "recife-pe": "recife-pe-todos",
  "fortaleza-ce": "fortaleza-ce-todos",
  "natal-rn": "natal-rn-todos",
  "maceio-al": "maceio-al-todos",
  "joao-pessoa-pb": "joao-pessoa-pb-todos",
  "aracaju-se": "aracaju-se-todos",
  "campo-grande-ms": "campo-grande-ms-todos",
  "cuiaba-mt": "cuiaba-mt-todos",
  "manaus-am": "manaus-am-todos",
  "belem-pa": "belem-pa-todos",
  "sao-luis-ma": "sao-luis-ma-todos",
  "teresina-pi": "teresina-pi-todos",
};

function gerarSecureToken(
  relativeUrl: string,
  userAgent = DEFAULT_USER_AGENT,
): string {
  const payload = {
    "fp-cb": "",
    "user-agent": userAgent,
  };
  const obj = {
    s: CLICKBUS_SECRET,
    u: relativeUrl,
    e: payload,
  };
  return createHash("sha1").update(JSON.stringify(obj)).digest("hex");
}

export async function resolverSlugClickBus(
  cidade: string,
  uf: string,
): Promise<string> {
  const { key: baseKey, nome } = canonicalCity(cidade, uf);
  if (METROPOLITAN_SLUGS[baseKey]) {
    return METROPOLITAN_SLUGS[baseKey];
  }
  return mappedCity("ClickBus", baseKey, async () => {
    const relativeUrl = `/web/api/v4/places?name=${encodeURIComponent(nome)}&clientId=2`;
    const token = gerarSecureToken(relativeUrl);
    const response = await monitoredFetch(
      `https://bff.clickbus.com${relativeUrl}`,
      {
        headers: {
          "user-agent": DEFAULT_USER_AGENT,
          "st-cb-px": token,
          accept: "application/json",
          referer: "https://www.clickbus.com.br/",
        },
        timeoutMs: 3500,
      },
    );

    if (!response.ok) throw new Error("CLICKBUS_HTTP_" + response.status);
    return resolveExactSlug(await response.json(), baseKey);
  });
}

export function clickBusTripUrl(tripId: string, benefit = true) {
  return `https://www.clickbus.com.br/viagem?tripId=${encodeURIComponent(tripId)}&clientId=2&discount=${benefit}&type=direct&isLowFare=false&isInTransit=false&flow=mfe`;
}

async function checarCotasViagemClickBus(
  tripId: string,
): Promise<ClickBusQuotas | null> {
  const url = clickBusTripUrl(tripId);
  try {
    const res = await monitoredFetch(url, {
      headers: {
        "user-agent": DEFAULT_USER_AGENT,
        accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "pt-BR,pt;q=0.9",
      },
      timeoutMs: 8000,
    });
    if ([401, 403, 429, 503].includes(res.status))
      throw new Error("PROVIDER_BLOCKED");
    if (!res.ok) return null;
    const html = await res.text();
    if (isClickBusChallengeHtml(html)) {
      blockMonitoringRequests();
      throw new Error("PROVIDER_BLOCKED");
    }
    return parseClickBusTripPage(html, tripId);
  } catch (error) {
    if (
      error instanceof Error &&
      ["PROVIDER_BLOCKED", "PROVIDER_REQUEST_BUDGET"].includes(error.message)
    )
      throw error;
    return null;
  }
}

const candidateCursors = new Map<string, number>();

function tripStops(part: {
  departure?: {
    city?: string | null;
    id?: string | null;
    name?: string | null;
  } | null;
  arrival?: {
    city?: string | null;
    id?: string | null;
    name?: string | null;
  } | null;
}) {
  const originStop = {
    city: part.departure?.city ?? null,
    id: part.departure?.id ?? null,
    terminal: part.departure?.name ?? null,
  };
  const destinationStop = {
    city: part.arrival?.city ?? null,
    id: part.arrival?.id ?? null,
    terminal: part.arrival?.name ?? null,
  };
  return {
    originStop,
    destinationStop,
    segments: [{ origin: originStop, destination: destinationStop }],
  };
}
export async function converterTripsClickBus(
  trips: unknown[],
  origem: string,
  origemUF: string,
  destino: string,
  destinoUF: string,
  dataIso: string,
  siteUrl: string,
  idJovem: boolean,
  loadQuota: (
    tripId: string,
  ) => Promise<ClickBusQuotas | null> = checarCotasViagemClickBus,
): Promise<{
  resultados: ResultItem[];
  unconfirmed: number;
  partial: boolean;
  coverage: {
    unsupportedConnections?: number;
    candidates: number;
    checked: number;
    unconfirmed: number;
    partial: boolean;
  };
}> {
  const resultados: ResultItem[] = [];

  // Filtra as viagens que atendem a rota e data
  const { rows, rejected } = parseRows(trips, clickTrip);
  const unsupported = rows.filter(
    (trip) => (trip.parts?.length ?? 0) > 1,
  ).length;
  const skipped = rejected + unsupported;
  const tripsFiltrados = rows.filter((trip) => {
    const part = trip.parts?.[0] || trip;
    if ((trip.parts?.length ?? 0) > 1) return false;
    const partidaData = part.departure?.date || trip.departure?.date;
    if (partidaData && partidaData !== dataIso) return false;

    const depState = part.departure?.state || trip.departure?.state || "";
    const arrState = part.arrival?.state || trip.arrival?.state || "";
    if (
      depState &&
      origemUF &&
      depState.toUpperCase() !== origemUF.toUpperCase()
    )
      return false;
    if (
      arrState &&
      destinoUF &&
      arrState.toUpperCase() !== destinoUF.toUpperCase()
    )
      return false;

    const depCity = part.departure?.city || trip.departure?.city || "";
    const arrCity = part.arrival?.city || trip.arrival?.city || "";
    if (depCity && !cityMatches(depCity, origem, origemUF)) return false;
    if (arrCity && !cityMatches(arrCity, destino, destinoUF)) return false;
    return true;
  });

  // Se não for modo ID Jovem, retorna todas as viagens comerciais normais
  if (!idJovem) {
    for (const trip of tripsFiltrados) {
      const part = trip.parts?.[0] || trip;
      const companyName =
        part.travelCompany?.name ||
        trip.travelCompany?.name ||
        trip.company?.name ||
        "Viação";
      const priceNum = trip.price != null ? Number(trip.price) : undefined;
      const horarioPartida =
        part.departure?.time?.slice(0, 5) ||
        trip.departure?.schedule?.time?.slice(0, 5) ||
        "N/A";
      const horarioChegada =
        part.arrival?.time?.slice(0, 5) ||
        trip.arrival?.schedule?.time?.slice(0, 5) ||
        "N/A";
      const duracao =
        typeof trip.duration === "string"
          ? trip.duration
          : typeof trip.duration?.hours === "string"
            ? trip.duration.hours
            : trip.duration?.hours
              ? `${trip.duration.hours}h`
              : typeof part.duration === "string"
                ? part.duration
                : undefined;

      const commercialTripId = part.tripId || trip.uuid;
      resultados.push({
        providerTripId:
          typeof (part.tripId || trip.uuid) === "string"
            ? part.tripId || trip.uuid || undefined
            : undefined,
        empresa: companyName,
        ...tripStops(part),
        arrivalDate: part.arrival?.date ?? undefined,
        horario: horarioPartida,
        chegada: horarioChegada,
        duracao,
        valor:
          priceNum != null
            ? `R$ ${priceNum.toFixed(2).replace(".", ",")}`
            : undefined,
        valorNumerico: priceNum,
        classe:
          part.serviceClass?.name ||
          trip.serviceClass?.name ||
          trip.anttServiceClass?.name ||
          undefined,
        tipoGratuidade: "nenhuma",
        vagasIdJovem: 0,
        poltronasLivres:
          part.availableSeats ?? trip.availableSeats ?? undefined,
        origem: `${origem} - ${origemUF}`,
        destino: `${destino} - ${destinoUF}`,
        data: dataIso,
        linkCompra: commercialTripId
          ? clickBusTripUrl(commercialTripId, false)
          : siteUrl,
      });
    }
    return {
      resultados,
      unconfirmed: skipped,
      partial: skipped > 0,
      coverage: {
        ...(unsupported ? { unsupportedConnections: unsupported } : {}),
        candidates: tripsFiltrados.length + skipped,
        checked: tripsFiltrados.length + skipped,
        unconfirmed: skipped,
        partial: skipped > 0,
      },
    };
  }

  // ID Jovem requires conventional service and an online benefit checkout.
  const candidatas = tripsFiltrados.filter((trip) => {
    const part = trip.parts?.[0] || trip;
    const anttClass = (
      part.serviceClass?.name ||
      trip.anttServiceClass?.name ||
      ""
    ).toLowerCase();
    return (
      ["convencional", "conv"].includes(anttClass.trim()) &&
      trip.options?.isGratuityTrip === true &&
      trip.options?.hasGratuityCheckout === true
    );
  });

  // Rotate small batches across future scheduled queries rather than bursting all trips.
  const offset = candidateCursors.get(siteUrl) || 0;
  const batch = Array.from(
    { length: Math.min(6, candidatas.length, remainingMonitoringRequests()) },
    (_, i) => candidatas[(offset + i) % candidatas.length],
  );
  candidateCursors.delete(siteUrl);
  candidateCursors.set(
    siteUrl,
    candidatas.length ? (offset + batch.length) % candidatas.length : 0,
  );
  if (candidateCursors.size > 100)
    candidateCursors.delete(candidateCursors.keys().next().value!);
  let unconfirmed = skipped;
  for (const trip of batch) {
    const partForId = trip.parts?.[0] || trip;
    const tripId = partForId.tripId || trip.uuid;
    if (typeof tripId !== "string" || !tripId) {
      unconfirmed++;
      continue;
    }
    const cotas = await loadQuota(tripId);
    if (!cotas) {
      unconfirmed++;
      continue;
    }

    const part = trip.parts?.[0] || trip;
    const companyName =
      part.travelCompany?.name ||
      trip.travelCompany?.name ||
      trip.company?.name ||
      "Viação";
    const horarioPartida =
      part.departure?.time?.slice(0, 5) ||
      trip.departure?.schedule?.time?.slice(0, 5) ||
      "N/A";
    const horarioChegada =
      part.arrival?.time?.slice(0, 5) ||
      trip.arrival?.schedule?.time?.slice(0, 5) ||
      "N/A";
    const duracao =
      typeof trip.duration === "string"
        ? trip.duration
        : typeof trip.duration?.hours === "string"
          ? trip.duration.hours
          : trip.duration?.hours
            ? `${trip.duration.hours}h`
            : typeof part.duration === "string"
              ? part.duration
              : undefined;
    const nomeClasse =
      part.serviceClass?.name ||
      trip.serviceClass?.name ||
      trip.anttServiceClass?.name ||
      undefined;
    const poltronasLivres =
      part.availableSeats ?? trip.availableSeats ?? undefined;

    for (const [percentage, slots, price] of [
      [100, cotas.vagas100, cotas.preco100],
      [50, cotas.vagas50, cotas.preco50],
    ] as const) {
      if (slots <= 0) continue;
      if (price === undefined) continue;
      resultados.push({
        empresa: companyName,
        ...tripStops(part),
        arrivalDate: part.arrival?.date ?? undefined,
        horario: horarioPartida,
        chegada: horarioChegada,
        duracao,
        valor: `R$ ${price.toFixed(2).replace(".", ",")}`,
        valorNumerico: price,
        classe: `${nomeClasse} (${percentage}% ID Jovem)`,
        providerTripId: tripId,
        tipoGratuidade: percentage === 100 ? "id_jovem_100" : "id_jovem_50",
        vagasIdJovem: slots,
        poltronasLivres,
        origem: `${origem} - ${origemUF}`,
        destino: `${destino} - ${destinoUF}`,
        data: dataIso,
        linkCompra: clickBusTripUrl(tripId),
      });
    }
    if (
      (cotas.vagas100 > 0 && cotas.preco100 === undefined) ||
      (cotas.vagas50 > 0 && cotas.preco50 === undefined)
    )
      unconfirmed++;
  }

  const partial = skipped > 0 || batch.length < candidatas.length;
  return {
    resultados,
    unconfirmed,
    partial,
    coverage: {
      ...(unsupported ? { unsupportedConnections: unsupported } : {}),
      candidates: candidatas.length + skipped,
      checked: batch.length + skipped,
      unconfirmed,
      partial: partial || unconfirmed > 0,
    },
  };
}

export class ClickBusSession {
  async init() {
    // Modo HTTP nativo com assinatura de Secure Token — sem necessidade de navegador
  }

  async buscarData(
    origem: string,
    origemUF: string,
    destino: string,
    destinoUF: string,
    dataIso: string,
    idJovem = false,
  ): Promise<ScraperResult> {
    const fromSlug = await resolverSlugClickBus(origem, origemUF);
    const toSlug = await resolverSlugClickBus(destino, destinoUF);
    const siteUrl = `https://www.clickbus.com.br/onibus/${fromSlug}/${toSlug}?departureDate=${dataIso}${idJovem ? "&gratuity=true" : ""}`;

    const relativeUrl = `/web/api/v6/trips?from=${fromSlug}&to=${toSlug}&departureDate=${dataIso}&clientId=2`;
    const fullUrl = `https://bff.clickbus.com${relativeUrl}`;

    try {
      const token = gerarSecureToken(relativeUrl);
      const response = await monitoredFetch(fullUrl, {
        headers: {
          "user-agent": DEFAULT_USER_AGENT,
          "st-cb-px": token,
          accept: "application/json, text/plain, */*",
          referer: "https://www.clickbus.com.br/",
          "cb-front-version": "0.15.108",
          "content-type": "application/json",
          "x-transaction-id": `SEARCH-MFE-${randomUUID()}`,
          "x-customer-session-id": `Web-${randomUUID()}`,
        },
        timeoutMs: 6000,
      });

      if (!response.ok) {
        console.warn(
          `[ClickBus] Resposta HTTP ${response.status} para ${relativeUrl}`,
        );
        return {
          error: `CLICKBUS_HTTP_${response.status}`,
          disponivel: false,
          vagasIdJovem: 0,
          detalhes:
            "Consulte o portal oficial da ClickBus para disponibilidade nesta rota.",
          siteUrl,
          empresa: "ClickBus",
          provedor: "ClickBus",
          dataConsultada: dataIso,
          resultados: [],
        };
      }

      const json = await response.json();
      if (!json || !Array.isArray(json.trips))
        throw new Error("CLICKBUS_INVALID_RESPONSE");
      const trips = json.trips;

      if (trips.length > 0) {
        const converted = await converterTripsClickBus(
          trips,
          origem,
          origemUF,
          destino,
          destinoUF,
          dataIso,
          siteUrl,
          idJovem,
        );

        const { resultados, unconfirmed, partial } = converted;
        return {
          coverage: converted.coverage,
          error:
            !resultados.length && (unconfirmed || partial)
              ? "ID_JOVEM_UNCONFIRMED"
              : undefined,
          disponivel: resultados.length > 0,
          vagasIdJovem: resultados.reduce(
            (total, item) => total + (item.vagasIdJovem || 0),
            0,
          ),
          detalhes: `${resultados.length} oferta(s) confirmada(s) na ClickBus para ${dataIso}${unconfirmed || partial ? "; verificação parcial das cotas, demais viagens aguardam consulta futura" : ""}`,
          siteUrl,
          empresa: "ClickBus",
          provedor: "ClickBus",
          dataConsultada: dataIso,
          resultados,
        };
      }

      return {
        disponivel: false,
        vagasIdJovem: 0,
        detalhes: "Nenhuma viagem disponível na ClickBus para esta data.",
        siteUrl,
        empresa: "ClickBus",
        provedor: "ClickBus",
        dataConsultada: dataIso,
        resultados: [],
      };
    } catch (err: any) {
      console.warn(
        `[ClickBus] Erro ao consultar ${relativeUrl}:`,
        err?.message || err,
      );
      return {
        error:
          err?.message === "PROVIDER_BLOCKED"
            ? "PROVIDER_BLOCKED"
            : "CLICKBUS_QUERY_FAILED",
        disponivel: false,
        vagasIdJovem: 0,
        detalhes:
          "Não foi possível confirmar disponibilidade; a consulta falhou. Acesse o portal oficial da ClickBus para disponibilidade nesta rota.",
        siteUrl,
        empresa: "ClickBus",
        provedor: "ClickBus",
        dataConsultada: dataIso,
        resultados: [],
      };
    }
  }

  async close() {
    // Sem necessidade de fechamento de navegador
  }
}

// Instância singleton para reuso em consultas de intervalo
let globalSession: ClickBusSession | null = null;

export async function getClickBusSession(): Promise<ClickBusSession> {
  if (!globalSession) {
    globalSession = new ClickBusSession();
  }
  return globalSession;
}
