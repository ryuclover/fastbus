import { validateProviderResult } from "../scrapers/result-contract";
import { withLocationMappings } from "../server/location-mappings";
import { scrapeClickBus } from "../scrapers/clickbus";
import { scrapeGontijo } from "../scrapers/gontijo";
import { scrapeGuanabara } from "../scrapers/guanabara";
import { scrapeBuser } from "../scrapers/buser";
import { scrapeEmbarca } from "../scrapers/embarca";
import { scrapeAguiaBranca } from "../scrapers/aguiabranca";
import { scrapeMobifacil } from "../scrapers/mobifacil";
import type { ScraperResult } from "../scrapers/types";

import {
  providerIds,
  type ProvedorId,
  PROVIDER_CAPABILITIES,
  type ProviderCapability,
} from "../../types/providers";
export type { ProvedorId, ProviderCapability } from "../../types/providers";
export { PROVIDER_CAPABILITIES } from "../../types/providers";

export interface ContextoProvedor {
  origem: string;
  origemUF: string;
  destino: string;
  destinoUF: string;
  dataIso: string;
  idJovem: boolean;
}

interface AdaptadorProvedor {
  id: ProvedorId;
  suportaIdJovem: boolean;
  consultar: (contexto: ContextoProvedor) => Promise<ScraperResult>;
}

const rawProviders: Record<ProvedorId, AdaptadorProvedor> = {
  ClickBus: {
    id: "ClickBus",
    suportaIdJovem: true,
    consultar: ({ origem, origemUF, destino, destinoUF, dataIso, idJovem }) =>
      scrapeClickBus(origem, destino, dataIso, origemUF, destinoUF, idJovem),
  },
  Guanabara: {
    id: "Guanabara",
    suportaIdJovem: true,
    consultar: ({ origem, origemUF, destino, destinoUF, dataIso, idJovem }) =>
      scrapeGuanabara(origem, destino, dataIso, origemUF, destinoUF, idJovem),
  },
  Buser: {
    id: "Buser",
    suportaIdJovem: false,
    consultar: ({ origem, origemUF, destino, destinoUF, dataIso, idJovem }) =>
      scrapeBuser(origem, origemUF, destino, destinoUF, dataIso, idJovem),
  },
  Gontijo: {
    id: "Gontijo",
    suportaIdJovem: true,
    consultar: ({ origem, origemUF, destino, destinoUF, dataIso, idJovem }) =>
      scrapeGontijo(origem, origemUF, destino, destinoUF, dataIso, idJovem),
  },
  Embarca: {
    id: "Embarca",
    suportaIdJovem: true,
    consultar: ({ origem, origemUF, destino, destinoUF, dataIso, idJovem }) =>
      scrapeEmbarca(origem, origemUF, destino, destinoUF, dataIso, idJovem),
  },
  AguiaBranca: {
    id: "AguiaBranca",
    suportaIdJovem: true,
    consultar: ({ origem, origemUF, destino, destinoUF, dataIso, idJovem }) =>
      scrapeAguiaBranca(origem, origemUF, destino, destinoUF, dataIso, idJovem),
  },
  Mobifacil: {
    id: "Mobifacil",
    suportaIdJovem: true,
    consultar: ({ origem, origemUF, destino, destinoUF, dataIso, idJovem }) =>
      scrapeMobifacil(origem, origemUF, destino, destinoUF, dataIso, idJovem),
  },
};

function registeredAdapter(id: ProvedorId): AdaptadorProvedor {
  const raw = rawProviders[id];
  return {
    ...raw,
    consultar: async (ctx) =>
      validateProviderResult(
        await withLocationMappings(() => raw.consultar(ctx)),
        id,
        ctx.dataIso,
        Date.now(),
        {
          origin: ctx.origem + "::" + ctx.origemUF,
          destination: ctx.destino + "::" + ctx.destinoUF,
        },
      ),
  };
}
export const adaptadoresProvedores = Object.fromEntries(
  providerIds.map((id) => [id, registeredAdapter(id)]),
) as Record<ProvedorId, AdaptadorProvedor>;

export function obterAdaptadores(
  provedores?: ProvedorId[],
  idJovem = false,
): AdaptadorProvedor[] {
  const ids = provedores || providerIds;
  return ids
    .map((id) => adaptadoresProvedores[id])
    .filter((adaptador) => adaptador && (!idJovem || adaptador.suportaIdJovem));
}
