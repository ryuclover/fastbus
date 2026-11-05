import { parseMobifacilServices } from "./parser";
import { canonicalCity, resolveExactSlug, reportedDate } from "../location";
import { monitoredFetch } from "../../monitoring/request-budget";
import { mappedCity } from "../../server/location-mappings";
import { ResultItem, ScraperResult } from "../types";

function normalizarNome(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function formatarDataBr(dataIso: string): string {
  const [ano, mes, dia] = dataIso.split("-");
  return `${dia}/${mes}/${ano}`;
}

/**
 * Consulta a API de localidades da Mobifácil para encontrar o slug correspondente à cidade e UF.
 */
const STATIC_SLUGS_MOBIFACIL: Record<string, string> = {
  "sao-paulo_SP": "sao-paulo-sp",
  "rio-de-janeiro_RJ": "rio-de-janeiro-rj",
  curitiba_PR: "curitiba-pr",
  "belo-horizonte_MG": "belo-horizonte-mg",
  campinas_SP: "campinas-sp",
  santos_SP: "santos-sp",
  sorocaba_SP: "sorocaba-sp",
  londrina_PR: "londrina-pr",
  maringa_PR: "maringa-pr",
};

async function resolverSlugMobifacil(
  cidade: string,
  uf: string,
  signal?: AbortSignal,
): Promise<string> {
  const chaveCache = `${normalizarNome(cidade).replace(/\s+/g, "-")}_${uf.toUpperCase()}`;
  if (STATIC_SLUGS_MOBIFACIL[chaveCache]) {
    return STATIC_SLUGS_MOBIFACIL[chaveCache];
  }

  const url = `https://www.mobifacil.com.br/on/demandware.store/Sites-Mobifacil-Site/pt_BR/Ticket-GetOrigins?search=${encodeURIComponent(
    normalizarNome(cidade),
  )}`;

  const { key } = canonicalCity(cidade, uf);
  return mappedCity("Mobifacil", key, async () => {
    const resp = await monitoredFetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*",
      },
      signal,
      timeoutMs: 8000,
    });

    if (!resp.ok) throw new Error("HTTP_" + resp.status);
    const data = await resp.json();
    return resolveExactSlug(data?.origins, key);
  });
}

export async function scrapeMobifacil(
  origem: string,
  origemUF: string,
  destino: string,
  destinoUF: string,
  dataIso: string,
  idJovem = false,
): Promise<ScraperResult> {
  const dataBr = formatarDataBr(dataIso);
  const defaultSiteUrl = "https://www.mobifacil.com.br";

  try {
    // Cada chamada tem seu prazo de rede após a espera na fila; o worker limita o total.
    const origemSlug = await resolverSlugMobifacil(origem, origemUF);
    const destinoSlug = await resolverSlugMobifacil(destino, destinoUF);

    const searchUrl = `https://www.mobifacil.com.br/passagem-de-onibus/${origemSlug}/${destinoSlug}?date=${encodeURIComponent(
      dataBr,
    )}`;

    // 2. Fazer requisição à página da rota
    const resp = await monitoredFetch(searchUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      timeoutMs: 10000,
    });

    if (resp.status === 404) {
      return {
        disponivel: false,
        vagasIdJovem: 0,
        detalhes:
          "Rota não operada pela Mobifácil ou parceiras do Grupo Comporte.",
        siteUrl: searchUrl,
        empresa: "Mobifácil",
        provedor: "Mobifacil",
        dataConsultada: dataIso,
        resultados: [],
        error: "COVERAGE_NOT_IMPLEMENTED",
      };
    }

    if (!resp.ok) {
      throw new Error(`HTTP_${resp.status}`);
    }

    const html = await resp.text();
    const parsed = parseMobifacilServices(html);
    if (parsed.state === "invalid")
      throw new Error("PROVIDER_INVALID_RESPONSE");
    const servicos = parsed.services;

    if (servicos.length === 0) {
      return {
        disponivel: false,
        vagasIdJovem: 0,
        detalhes: `Nenhum horário encontrado na Mobifácil para ${dataBr}.`,
        siteUrl: searchUrl,
        empresa: "Mobifácil",
        provedor: "Mobifacil",
        dataConsultada: dataIso,
        resultados: [],
      };
    }

    // 3. Tratamento estrito de ID Jovem (Zero falso positivo)
    if (idJovem) {
      // Identificar se existem viagens na classe Convencional na rota
      const viagensConvencionais = servicos.filter((s) =>
        s.classe?.toUpperCase()?.includes("CONVENCIONAL"),
      );

      return {
        disponivel: false,
        vagasIdJovem: 0,
        detalhes:
          viagensConvencionais.length > 0
            ? `A Mobifácil possui ${viagensConvencionais.length} partida(s) convencional(is) nesta rota. Conforme a política oficial, gratuidades ID Jovem devem ser emitidas presencialmente em agências ou via chat oficial.`
            : "A Mobifácil não possui viagens convencionais com cota ID Jovem online direta para esta rota.",
        siteUrl: searchUrl,
        empresa: "Mobifácil",
        provedor: "Mobifacil",
        dataConsultada: dataIso,
        resultados: [],
      };
    }

    // 4. Modo Comercial / Geral: mapear todas as passagens disponíveis
    const resultados: ResultItem[] = servicos.map((s) => {
      const preco = s.preco ?? undefined;
      const horarioSaida = s.saida
        ? s.saida.split(" ")[1]?.substring(0, 5)
        : undefined;
      const horarioChegada = s.chegada
        ? s.chegada.split(" ")[1]?.substring(0, 5)
        : undefined;

      return {
        empresa: s.empresa || "Mobifácil (Grupo Comporte)",
        horario: horarioSaida,
        chegada: horarioChegada,
        arrivalDate: s.chegada
          ? reportedDate(s.chegada, "") || undefined
          : undefined,
        duracao: s.duration,
        valor:
          preco !== undefined
            ? `R$ ${preco.toFixed(2).replace(".", ",")}`
            : undefined,
        valorNumerico: preco,
        classe: s.classe,
        tipoGratuidade: "nenhuma",
        vagasIdJovem: 0,
        poltronasLivres:
          typeof s.poltronasLivres === "number" ? s.poltronasLivres : undefined,
        origem: s.originName || `${origem} - ${origemUF}`,
        destino: s.destinationName || `${destino} - ${destinoUF}`,
        data: reportedDate(s.saida, dataIso),
        linkCompra: searchUrl,
      };
    });

    return {
      disponivel: resultados.length > 0,
      vagasIdJovem: 0,
      detalhes: `Encontradas ${resultados.length} opções de viagens na Mobifácil.`,
      coverage: {
        candidates: parsed.received,
        checked: parsed.received,
        unconfirmed: parsed.rejected,
        partial: parsed.state === "partial",
      },
      siteUrl: searchUrl,
      empresa: "Mobifácil",
      provedor: "Mobifacil",
      dataConsultada: dataIso,
      resultados,
    };
  } catch (error: any) {
    const isTimeout =
      error.name === "AbortError" || error.message?.includes("timeout");
    return {
      disponivel: false,
      vagasIdJovem: 0,
      detalhes: isTimeout
        ? "Consulta à Mobifácil excedeu o tempo limite."
        : `Erro ao consultar Mobifácil: ${error.message || error}`,
      siteUrl: defaultSiteUrl,
      empresa: "Mobifácil",
      provedor: "Mobifacil",
      dataConsultada: dataIso,
      resultados: [],
      error: isTimeout ? "PROVIDER_TIMEOUT" : error.message || "SCRAPE_ERROR",
    };
  }
}

export const consultarMobifacil = scrapeMobifacil;
