import { reportedDate } from "../location";
import { embarcaTrip, parseRows } from "../raw-contracts";
import {
  monitoredFetch,
  currentMonitoringBudget,
} from "../../monitoring/request-budget";
import { diagnosticCode } from "../../monitoring/diagnostics";
import { ResultItem, ScraperResult } from "../types";
import { fetchWithRetry } from "../../http-client";

function normalizarTexto(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
}

function montarSlugEmbarca(cidade: string, uf: string): string {
  const nomeLimpo = normalizarTexto(cidade);
  const ufLimpa = uf.toLowerCase().trim();

  // Polos metropolitanos com múltiplos terminais mapeados com sufixo -todos pela Embarca.ai
  const polosComTodos = new Set(["rio-de-janeiro", "sao-paulo"]);
  if (polosComTodos.has(nomeLimpo)) {
    return `${nomeLimpo}-${ufLimpa}-todos`;
  }

  return `${nomeLimpo}-${ufLimpa}`;
}

function extrairInitialTripsJson(html: string): any[] | null {
  const keyIdx = html.indexOf("initialTrips");
  if (keyIdx === -1) return null;

  const jsonStart = html.indexOf("[", keyIdx);
  if (jsonStart === -1 || jsonStart - keyIdx > 50) return null;

  let depth = 0;
  let inString = false;
  let escape = false;
  let jsonEnd = -1;

  for (let i = jsonStart; i < html.length; i++) {
    const c = html[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\") {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (!inString) {
      if (c === "[") depth++;
      else if (c === "]") {
        depth--;
        if (depth === 0) {
          jsonEnd = i + 1;
          break;
        }
      }
    }
  }

  if (jsonEnd === -1) return null;

  try {
    const rawSlice = html.slice(jsonStart, jsonEnd);
    const cleanJson = rawSlice.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    const parsed = JSON.parse(cleanJson);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function processarTripsEmbarca(
  trips: any[],
  origem: string,
  origemUF: string,
  destino: string,
  destinoUF: string,
  dataIso: string,
  siteUrl: string,
  idJovem: boolean,
): ResultItem[] {
  const resultados: ResultItem[] = [];

  // MODO COMERCIAL PADRÃO (idJovem = false)
  if (!idJovem) {
    for (const t of trips) {
      const empresa = t.operator_name || t.operator?.name || "Embarca.ai";
      const partida = t.departure_at ? t.departure_at.slice(11, 16) : undefined;
      const chegada = t.arrival_at ? t.arrival_at.slice(11, 16) : undefined;
      const duracao =
        t.hours && t.minutes
          ? `${t.hours} ${t.minutes}`
          : t.hours
            ? `${t.hours}`
            : "Consulte site";
      const classe = t.seat_class || t.group || undefined;
      const precoNumerico =
        typeof t.price === "number" ? t.price : parseFloat(t.price);
      if (!Number.isFinite(precoNumerico) || precoNumerico < 0) continue;

      resultados.push({
        empresa,
        providerTripId: t.id == null ? undefined : String(t.id),
        departureAt:
          t.departure_at && /(?:Z|[+-]\d{2}:\d{2})$/.test(t.departure_at)
            ? Date.parse(t.departure_at)
            : undefined,
        horario: partida,
        chegada,
        arrivalDate: t.arrival_at?.slice(0, 10),
        arrivalAt:
          t.arrival_at && /(?:Z|[+-]\d{2}:\d{2})$/.test(t.arrival_at)
            ? Date.parse(t.arrival_at)
            : undefined,
        duracao,
        valor: `R$ ${precoNumerico.toFixed(2).replace(".", ",")}`,
        valorNumerico: precoNumerico,
        classe,
        tipoGratuidade: "nenhuma",
        vagasIdJovem: 0,
        poltronasLivres: t.available_seats ?? undefined,
        origem: `${origem} - ${origemUF}`,
        destino: `${destino} - ${destinoUF}`,
        data: reportedDate(t.departure_at, dataIso, origem + "::" + origemUF),
        linkCompra: siteUrl,
      });
    }
    return resultados;
  }

  // MODO ID JOVEM ESTRITO (falso negativo preferível a falso positivo)
  for (const t of trips) {
    const classeRaw = (t.seat_class || t.group || "").toUpperCase();
    const isConvencional = ["CONVENCIONAL", "CONV"].includes(classeRaw.trim());

    // Requisito 1: Apenas linhas de serviço CONVENCIONAL
    if (!isConvencional) continue;

    // Requisito 2: Array gratuity_types obrigatório
    const gratuityTypes = Array.isArray(t.gratuity_types)
      ? t.gratuity_types
      : [];
    if (gratuityTypes.length === 0) continue;

    const empresa = t.operator_name || t.operator?.name || "Embarca.ai";
    const partida = t.departure_at ? t.departure_at.slice(11, 16) : undefined;
    const chegada = t.arrival_at ? t.arrival_at.slice(11, 16) : undefined;
    const duracao =
      t.hours && t.minutes
        ? `${t.hours} ${t.minutes}`
        : t.hours
          ? `${t.hours}`
          : "Consulte site";
    const nomeClasse = t.seat_class || t.group || undefined;
    const poltronasLivres = t.available_seats ?? undefined;

    // Require a numeric quota; eligibility flags are not confirmed seats.
    const cota100Obj = gratuityTypes.find((g: any) => {
      if (typeof g !== "object" || !g) return false;
      const isIdJovem =
        g.category_id === 5 ||
        g.subcategory === "young_100" ||
        (g.name && g.name.toLowerCase().includes("id jovem (100%)"));
      const vagas = g.available_seats_quantity ?? g.available;
      return isIdJovem && typeof vagas === "number" && vagas > 0;
    });

    // Buscar cota de 50% ID Jovem com vagas reais (> 0)
    const cota50Obj = gratuityTypes.find((g: any) => {
      if (typeof g !== "object" || !g) return false;
      const isIdJovem =
        g.category_id === 6 ||
        g.subcategory === "young_50" ||
        (g.name && g.name.toLowerCase().includes("id jovem (50%)"));
      const vagas = g.available_seats_quantity ?? g.available;
      return isIdJovem && typeof vagas === "number" && vagas > 0;
    });

    if (!cota100Obj && !cota50Obj) continue;

    // 1. Cota ID Jovem 100%
    if (cota100Obj) {
      const vagas100 =
        cota100Obj.available_seats_quantity ?? cota100Obj.available;
      const taxa =
        cota100Obj?.total_price != null
          ? parseFloat(cota100Obj.total_price)
          : NaN;
      resultados.push({
        empresa,
        providerTripId: t.id == null ? undefined : String(t.id),
        departureAt:
          t.departure_at && /(?:Z|[+-]\d{2}:\d{2})$/.test(t.departure_at)
            ? Date.parse(t.departure_at)
            : undefined,
        horario: partida,
        chegada,
        arrivalDate: t.arrival_at?.slice(0, 10),
        arrivalAt:
          t.arrival_at && /(?:Z|[+-]\d{2}:\d{2})$/.test(t.arrival_at)
            ? Date.parse(t.arrival_at)
            : undefined,
        duracao,
        valor: taxa > 0 ? `R$ ${taxa.toFixed(2).replace(".", ",")}` : "R$ 0,00",
        valorNumerico: taxa,
        totalMinor: Number.isFinite(taxa) ? Math.round(taxa * 100) : undefined,
        classe: `${nomeClasse} (100% ID Jovem)`,
        tipoGratuidade: "id_jovem_100",
        vagasIdJovem: vagas100,
        poltronasLivres,
        origem: `${origem} - ${origemUF}`,
        destino: `${destino} - ${destinoUF}`,
        data: reportedDate(t.departure_at, dataIso, origem + "::" + origemUF),
        linkCompra: siteUrl,
      });
    }

    // 2. Cota ID Jovem 50%
    if (cota50Obj) {
      const vagas50 =
        cota50Obj.available_seats_quantity ?? cota50Obj.available ?? 1;
      const preco50 =
        cota50Obj.total_price != null ? parseFloat(cota50Obj.total_price) : NaN;
      resultados.push({
        empresa,
        providerTripId: t.id == null ? undefined : String(t.id),
        departureAt:
          t.departure_at && /(?:Z|[+-]\d{2}:\d{2})$/.test(t.departure_at)
            ? Date.parse(t.departure_at)
            : undefined,
        horario: partida,
        chegada,
        arrivalDate: t.arrival_at?.slice(0, 10),
        arrivalAt:
          t.arrival_at && /(?:Z|[+-]\d{2}:\d{2})$/.test(t.arrival_at)
            ? Date.parse(t.arrival_at)
            : undefined,
        duracao,
        valor:
          preco50 > 0
            ? `R$ ${preco50.toFixed(2).replace(".", ",")}`
            : "50% Desconto",
        valorNumerico: preco50,
        totalMinor: Number.isFinite(preco50)
          ? Math.round(preco50 * 100)
          : undefined,
        classe: `${nomeClasse} (50% ID Jovem)`,
        tipoGratuidade: "id_jovem_50",
        vagasIdJovem: vagas50,
        poltronasLivres,
        origem: `${origem} - ${origemUF}`,
        destino: `${destino} - ${destinoUF}`,
        data: reportedDate(t.departure_at, dataIso, origem + "::" + origemUF),
        linkCompra: siteUrl,
      });
    }
  }

  return resultados;
}

export async function scrapeEmbarca(
  origem: string,
  origemUF: string,
  destino: string,
  destinoUF: string,
  dataIso: string,
  idJovem = false,
): Promise<ScraperResult> {
  const origemSlug = montarSlugEmbarca(origem, origemUF);
  const destinoSlug = montarSlugEmbarca(destino, destinoUF);
  const siteUrl = `https://www.embarca.ai/passagem-de-onibus/${origemSlug}/${destinoSlug}?departure_at=${dataIso}&round_trip=`;
  const apiUrl = `https://www.embarca.ai/api/v1/trips/${origemSlug}/${destinoSlug}?departure_at=${dataIso}${idJovem ? "&gratuity=true" : ""}&web_request=true`;

  try {
    let trips: any[] | null = null;
    let failure: unknown;

    // 1. Consulta prioritária via API oficial JSON da Embarca.ai (fornece cotas dinâmicas g.available)
    try {
      const apiResponse = await monitoredFetch(apiUrl, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          Referer: "https://www.embarca.ai/",
          "Accept-Language": "pt-BR,pt;q=0.9",
        },
        timeoutMs: 8500,
      });

      if (apiResponse.status === 404) {
        return {
          disponivel: false,
          vagasIdJovem: 0,
          detalhes: "Rota não operada ou sem cadastro na Embarca.ai",
          siteUrl,
          empresa: "Embarca.ai",
          provedor: "Embarca",
          dataConsultada: dataIso,
          resultados: [],
          error: "COVERAGE_NOT_IMPLEMENTED",
        };
      }

      if (apiResponse.ok) {
        const json = await apiResponse.json();
        if (Array.isArray(json)) {
          trips = json;
        } else throw new Error("PROVIDER_INVALID_RESPONSE");
      } else throw new Error(`HTTP_${apiResponse.status}`);
    } catch (error) {
      failure = error;
      if (currentMonitoringBudget()?.blockedUntil) throw error;
      // Fallback para SSR se a API falhar
    }

    // 2. Fallback via SSR da página pública
    if (trips === null) {
      try {
        const response = await fetchWithRetry(
          siteUrl,
          {
            headers: {
              "User-Agent":
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
              Accept:
                "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
              "Accept-Language": "pt-BR,pt;q=0.9",
            },
            timeoutMs: 8000,
          },
          1,
        );

        if (response.status === 404) {
          return {
            disponivel: false,
            vagasIdJovem: 0,
            detalhes: "Rota não operada ou sem cadastro na Embarca.ai",
            siteUrl,
            empresa: "Embarca.ai",
            provedor: "Embarca",
            dataConsultada: dataIso,
            resultados: [],
            error: "COVERAGE_NOT_IMPLEMENTED",
          };
        }

        if (response.ok) {
          const html = await response.text();
          trips = extrairInitialTripsJson(html);
          if (trips === null) throw new Error("PROVIDER_INVALID_RESPONSE");
        } else throw new Error(`HTTP_${response.status}`);
      } catch (error) {
        failure = error;
      }
    }
    if (trips === null) throw failure || new Error("PROVIDER_INVALID_RESPONSE");

    const { rows, rejected } = parseRows(trips, embarcaTrip);
    const resultados = processarTripsEmbarca(
      rows,
      origem,
      origemUF,
      destino,
      destinoUF,
      dataIso,
      siteUrl,
      idJovem,
    );

    const disponivel = resultados.length > 0;
    const vagasIdJovem =
      idJovem && disponivel
        ? resultados.reduce((acc, item) => acc + (item.vagasIdJovem || 0), 0)
        : 0;
    const detalhes = disponivel
      ? `${resultados.length} viagem(ns) encontrada(s) na Embarca.ai`
      : idJovem
        ? "Nenhuma vaga de ID Jovem confirmada na Embarca.ai para esta data."
        : "Nenhum horário encontrado na Embarca.ai para esta data.";

    return {
      coverage: {
        candidates: trips.length,
        checked: trips.length,
        unconfirmed: rejected,
        partial: rejected > 0,
      },
      disponivel,
      vagasIdJovem,
      detalhes,
      siteUrl,
      empresa: "Embarca.ai",
      provedor: "Embarca",
      dataConsultada: dataIso,
      resultados,
    };
  } catch (err: any) {
    return {
      disponivel: false,
      vagasIdJovem: 0,
      detalhes: "Não foi possível concluir a consulta à Embarca.ai.",
      siteUrl,
      empresa: "Embarca.ai",
      provedor: "Embarca",
      dataConsultada: dataIso,
      resultados: [],
      error: diagnosticCode(err),
    };
  }
}

export const consultarEmbarca = scrapeEmbarca;
