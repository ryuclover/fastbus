import { withRequestBudget } from "./request-budget";
import type { Query } from "./engine";
import { adaptadoresProvedores } from "../services/provedores";
import { diagnosticCode } from "./diagnostics";

export const queryProvider: Query = async (config, provider, date) => {
  const [origem, origemUF] = config.origin.split("::");
  const [destino, destinoUF] = config.destination.split("::");
  const { result, budget } = await withRequestBudget(async () => {
    try {
      return await adaptadoresProvedores[provider].consultar({
        origem,
        origemUF,
        destino,
        destinoUF,
        dataIso: date,
        idJovem: config.benefit !== "any",
      });
    } catch (error) {
      return {
        disponivel: false,
        vagasIdJovem: 0,
        detalhes: "Falha na consulta",
        siteUrl: "",
        provedor: provider,
        resultados: [],
        error: diagnosticCode(error),
        outcome: "failed" as const,
      };
    }
  });
  return {
    result,
    blockedUntil: budget.blockedUntil,
    limited: budget.limited,
  };
};
