import { routeSlugParts } from "../location";
import { ScraperResult } from "../types";
import { fetchGuanabaraDirect } from "./client";

export async function scrapeGuanabara(
  origemOuUrl: string,
  destino = "",
  data = "",
  origemUF = "RJ",
  destinoUF = "SP",
  idJovem = false,
): Promise<ScraperResult> {
  if (origemOuUrl.startsWith("http")) {
    const url = new URL(origemOuUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      !["viajeguanabara.com.br", "www.viajeguanabara.com.br"].includes(
        url.hostname,
      ) ||
      parts.length !== 3 ||
      parts[0] !== "onibus"
    )
      throw new Error("LOCATION_NOT_FOUND");
    const from = routeSlugParts(parts[1]),
      to = routeSlugParts(parts[2]);
    return fetchGuanabaraDirect(
      from.city,
      from.uf,
      to.city,
      to.uf,
      url.searchParams.get("departure_date") ?? "",
      url.searchParams.get("passengers") === "13:1",
    );
  }

  return fetchGuanabaraDirect(
    origemOuUrl,
    origemUF,
    destino,
    destinoUF,
    data,
    idJovem,
  );
}

export { fetchGuanabaraDirect };
export * from "./client";
