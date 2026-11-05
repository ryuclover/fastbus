import { reportedDate } from "../location";
import { commercialCard, decimalPrice } from "../raw-contracts";
import { ResultItem, ScraperResult } from "../types";
import { fetchWithRetry } from "../../http-client";

function normalizarSlugAguia(cidade: string, uf: string): string {
  const nomeLimpo = (cidade || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  const ufLimpa = (uf || "").toLowerCase().trim();
  return `${nomeLimpo}-${ufLimpa}`;
}

function formatarDataBr(dataIso: string): string {
  const [ano, mes, dia] = dataIso.split("-");
  return `${dia}-${mes}-${ano}`;
}

function calcularDuracao(saidaStr?: string, chegadaStr?: string): string {
  if (!saidaStr || !chegadaStr) return "Consulte site";
  try {
    // Formato: DD/MM/YYYY HH:MM
    const [dSaida, mSaida, ySaida, hSaida, minSaida] =
      saidaStr.split(/[\/\s:]/);
    const [dCheg, mCheg, yCheg, hCheg, minCheg] = chegadaStr.split(/[\/\s:]/);
    const dtSaida = new Date(
      Number(ySaida),
      Number(mSaida) - 1,
      Number(dSaida),
      Number(hSaida),
      Number(minSaida),
    );
    const dtCheg = new Date(
      Number(yCheg),
      Number(mCheg) - 1,
      Number(dCheg),
      Number(hCheg),
      Number(minCheg),
    );
    const diffMs = dtCheg.getTime() - dtSaida.getTime();
    if (diffMs <= 0 || isNaN(diffMs)) return "Consulte site";
    const horas = Math.floor(diffMs / (1000 * 60 * 60));
    const minutos = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    return `${horas}h ${minutos.toString().padStart(2, "0")}min`;
  } catch {
    return "Consulte site";
  }
}

export async function scrapeAguiaBranca(
  origem: string,
  origemUF: string,
  destino: string,
  destinoUF: string,
  dataIso: string,
  idJovem = false,
): Promise<ScraperResult> {
  const origemSlug = normalizarSlugAguia(origem, origemUF);
  const destinoSlug = normalizarSlugAguia(destino, destinoUF);
  const dataBr = formatarDataBr(dataIso);

  const queryParams = new URLSearchParams({
    Ida: dataBr,
    adulto: "1",
  });
  if (idJovem) {
    queryParams.set("freeTicketType", "5"); // 5 = JOVEM CARENTE 100%
  }

  const searchUrl = `https://www.aguiabranca.com.br/onibus/${origemSlug}/${destinoSlug}?${queryParams.toString()}`;
  const siteUrl = idJovem
    ? "https://www.aguiabranca.com.br/gratuidade"
    : searchUrl;

  // The existing HTML parser only assumed two free seats from the selected filter.
  // Do not generate an automatic opportunity until the actual quota can be verified.
  if (idJovem)
    return {
      disponivel: false,
      vagasIdJovem: 0,
      detalhes: "Cota ID Jovem não confirmada automaticamente nesta fonte.",
      siteUrl,
      provedor: "AguiaBranca",
      dataConsultada: dataIso,
      resultados: [],
      error: "ID_JOVEM_UNCONFIRMED",
    };

  try {
    const response = await fetchWithRetry(
      searchUrl,
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7",
          "Upgrade-Insecure-Requests": "1",
        },
        timeoutMs: 8500,
      },
      1,
    );

    if (response.status === 404) {
      return {
        disponivel: false,
        vagasIdJovem: 0,
        detalhes: "Rota não operada diretamente pela Águia Branca",
        siteUrl,
        empresa: "Águia Branca",
        provedor: "AguiaBranca",
        dataConsultada: dataIso,
        resultados: [],
        error: "COVERAGE_NOT_IMPLEMENTED",
      };
    }

    if (!response.ok) {
      throw new Error(`HTTP_${response.status}`);
    }

    const html = await response.text();
    const resultados: ResultItem[] = [];

    // 1. Extração via cartões SSR .y_fareResultTravelOption
    const cardRegex =
      /class="[^"]*y_fareResultTravelOption[^"]*"[\s\S]*?(?=(?:class="[^"]*y_fareResultTravelOption[^"]*")|<\/main>|$)/g;
    const cards = html.match(cardRegex) || [];

    let rejected = 0;
    if (cards.length > 1000) throw new Error("PROVIDER_INVALID_RESPONSE");
    for (const card of cards) {
      const saidaCompleta = card
        .match(/class="[^"]*saida"[^>]*>([^<]+)</)?.[1]
        ?.trim();
      const chegadaCompleta = card
        .match(/class="[^"]*chegada"[^>]*>([^<]+)</)?.[1]
        ?.trim();
      const classe =
        card.match(/class="[^"]*classe"[^>]*>([^<]+)</)?.[1]?.trim() ||
        undefined;
      let empresa =
        card.match(/class="[^"]*empresa"[^>]*>([^<]+)</)?.[1]?.trim() ||
        "Águia Branca";
      if (/aguia\s*branca/i.test(empresa)) {
        empresa = "Águia Branca";
      }

      const horarioPartida = saidaCompleta
        ? saidaCompleta.slice(-5)
        : undefined;
      const horarioChegada = chegadaCompleta
        ? chegadaCompleta.slice(-5)
        : undefined;
      const duracao = calcularDuracao(saidaCompleta, chegadaCompleta);

      // Extração de poltronas livres disponíveis
      const assentosLivresMatch = card.match(
        /class="[^"]*assentos-livres"[^>]*>([^<]+)</,
      );
      let poltronasLivres: number | undefined = undefined;
      if (assentosLivresMatch) {
        const parsedAssentos = parseInt(assentosLivresMatch[1].trim(), 10);
        if (!isNaN(parsedAssentos)) {
          poltronasLivres = parsedAssentos;
        }
      }

      let valorNumerico: number | undefined = undefined;
      let valorFormatado: string | undefined = undefined;

      // Tenta pegar data-price="559.86" ou texto R$ 559,86
      const dataPriceMatch = card.match(/data-price="([\d\.]+)"/);
      if (dataPriceMatch) {
        const parsed = decimalPrice.safeParse(dataPriceMatch[1]).data ?? NaN;
        if (!isNaN(parsed) && parsed >= 0) {
          valorNumerico = parsed;
          valorFormatado = `R$ ${parsed.toFixed(2).replace(".", ",")}`;
        }
      } else {
        const priceMatch = card.match(/R\$(?:&nbsp;|\s)*([\d\.,]+)/i);
        if (priceMatch) {
          const rawPreco = priceMatch[1].replace(/\./g, "").replace(",", ".");
          const parsed = /^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{2})?$/.test(
            priceMatch[1],
          )
            ? (decimalPrice.safeParse(rawPreco).data ?? NaN)
            : NaN;
          if (!isNaN(parsed) && parsed >= 0) {
            valorNumerico = parsed;
            valorFormatado = `R$ ${parsed.toFixed(2).replace(".", ",")}`;
          }
        }
      }
      if (
        !commercialCard.safeParse({
          price: valorNumerico,
          departure: horarioPartida,
          arrival: horarioChegada,
        }).success
      ) {
        rejected++;
        continue;
      }
      resultados.push({
        empresa,
        horario: horarioPartida,
        chegada: horarioChegada,
        arrivalDate: chegadaCompleta
          ? reportedDate(chegadaCompleta, "") || undefined
          : undefined,
        duracao,
        valor: valorFormatado,
        valorNumerico,
        classe,
        tipoGratuidade: "nenhuma",
        vagasIdJovem: 0,
        poltronasLivres,
        origem: `${origem} - ${origemUF}`,
        destino: `${destino} - ${destinoUF}`,
        data: reportedDate(saidaCompleta, dataIso),
        linkCompra: searchUrl,
      });
    }

    // 2. Se os cartões HTML não vieram mas há items no dataLayer push (fallback)
    if (cards.length === 0) {
      const itemPushRegex =
        /"item_sku"\s*:\s*'([^']+)'[\s\S]*?"price"\s*:\s*'([^']+)'[\s\S]*?"item_category"\s*:\s*'([^']+)'/g;
      let mItem: RegExpExecArray | null;
      while ((mItem = itemPushRegex.exec(html)) !== null) {
        const price = decimalPrice.safeParse(mItem[2]).data ?? NaN;
        const dataHora = mItem[3]; // "11/09/2026 07:00"
        const horaPartida = dataHora.slice(-5);
        if (resultados.length + rejected >= 1000)
          throw new Error("PROVIDER_INVALID_RESPONSE");
        if (
          !commercialCard.safeParse({ price, departure: horaPartida }).success
        ) {
          rejected++;
          continue;
        }
        if (Number.isFinite(price)) {
          resultados.push({
            empresa: "Águia Branca",
            horario: horaPartida,
            chegada: undefined,
            duracao: "Consulte site",
            valor: `R$ ${price.toFixed(2).replace(".", ",")}`,
            valorNumerico: price,
            providerTripId: mItem[1],
            tipoGratuidade: "nenhuma",
            vagasIdJovem: 0,
            origem: `${origem} - ${origemUF}`,
            destino: `${destino} - ${destinoUF}`,
            data: reportedDate(dataHora, dataIso),
            linkCompra: searchUrl,
          });
        }
      }
    }

    if (!resultados.length) throw new Error("PROVIDER_INVALID_RESPONSE");
    const disponivel = resultados.length > 0;
    const detalhes = disponivel
      ? `${resultados.length} viagem(ns) encontrada(s) na Águia Branca`
      : "Nenhum horário comercial encontrado na Águia Branca para esta data.";

    return {
      coverage: {
        candidates: resultados.length + rejected,
        checked: resultados.length + rejected,
        unconfirmed: rejected,
        partial: rejected > 0,
      },
      disponivel,
      vagasIdJovem: 0,
      detalhes,
      siteUrl,
      empresa: "Águia Branca",
      provedor: "AguiaBranca",
      dataConsultada: dataIso,
      resultados,
    };
  } catch (err: any) {
    const isAborted =
      err?.name === "AbortError" ||
      err?.message?.includes("aborted") ||
      err?.message?.includes("timeout");
    return {
      disponivel: false,
      vagasIdJovem: 0,
      detalhes: isAborted
        ? "Consulta da Águia Branca atingiu o tempo limite. Tente diretamente pelo site oficial."
        : `Consulta indisponível para Águia Branca: ${err?.message || "Sem resposta"}`,
      siteUrl,
      empresa: "Águia Branca",
      provedor: "AguiaBranca",
      dataConsultada: dataIso,
      resultados: [],
      error: isAborted
        ? "PROVIDER_TIMEOUT"
        : err?.message === "PROVIDER_INVALID_RESPONSE"
          ? err.message
          : "QUERY_FAILED",
    };
  }
}

export const consultarAguiaBranca = scrapeAguiaBranca;
