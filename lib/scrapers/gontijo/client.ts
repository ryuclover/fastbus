import type { ScraperResult } from "../types";

/**
 * Cliente para direcionamento e orientação de passagens na Gontijo.
 * Como o backend de vendas da Gontijo utiliza proteções interativas e ações
 * proprietárias, o FastBus fornece orientação manual com links parametrizados
 * para o portal oficial de gratuidade JVVN (Jovem de Baixa Renda).
 */

const ESTADOS_COBERTURA_GONTIJO = new Set([
  "MG",
  "SP",
  "RJ",
  "BA",
  "ES",
  "GO",
  "DF",
  "TO",
  "PE",
  "CE",
  "PB",
  "RN",
  "AL",
  "SE",
  "PI",
  "MA",
]);

function formatarDataBr(dataIso: string): string {
  const [ano, mes, dia] = dataIso.split("-");
  return `${dia}/${mes}/${ano}`;
}

export async function scrapeGontijo(
  origem: string,
  origemUF: string,
  destino: string,
  destinoUF: string,
  dataIso: string,
  idJovem = false,
): Promise<ScraperResult> {
  const dataBr = formatarDataBr(dataIso);
  const origemCoberta = ESTADOS_COBERTURA_GONTIJO.has(origemUF.toUpperCase());
  const destinoCoberto = ESTADOS_COBERTURA_GONTIJO.has(destinoUF.toUpperCase());

  const siteUrl = idJovem
    ? `https://www.gontijo.com.br/gratuidade?trajeto=IDA&tipoVenda=JVVN&cidadeOrigem=${encodeURIComponent(
        origem,
      )}&cidadeDestino=${encodeURIComponent(destino)}&dataIda=${encodeURIComponent(dataBr)}`
    : `https://www.gontijo.com.br/`;

  if (!origemCoberta || !destinoCoberto) {
    return {
      disponivel: false,
      vagasIdJovem: 0,
      detalhes: `A rota ${origemUF} -> ${destinoUF} não faz parte da área de atuação informada da Gontijo.`,
      siteUrl,
      empresa: "Gontijo",
      provedor: "Gontijo",
      dataConsultada: dataIso,
      resultados: [],
      error: "COVERAGE_NOT_IMPLEMENTED",
    };
  }

  // Orientação manual baseada em atuação da empresa nos estados informados.
  // Uma lista de UFs não comprova ligação direta entre cidades específicas.
  return {
    disponivel: false,
    vagasIdJovem: 0,
    detalhes: idJovem
      ? "A Gontijo atua nos estados informados. Consulte o portal oficial JVVN ou guichê para verificar se há linha direta operada e vagas ID Jovem."
      : "A Gontijo atua nos estados informados. Consulte disponibilidade de horários e tarifas diretamente no portal oficial.",
    siteUrl,
    empresa: "Gontijo",
    provedor: "Gontijo",
    dataConsultada: dataIso,
    resultados: [],
    outcome: "manual",
  };
}
