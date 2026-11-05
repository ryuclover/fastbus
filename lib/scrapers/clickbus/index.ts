import { routeSlugParts } from "../location";
import { ScraperResult } from "../types";
import { getClickBusSession, ClickBusSession } from "./client";

export async function scrapeClickBus(
  origemOuUrl: string,
  destino = "",
  data = "",
  origemUF = "RJ",
  destinoUF = "SP",
  idJovem = false,
): Promise<ScraperResult> {
  const session =
    process.env.CLICKBUS_TRANSPORT === "browser"
      ? (await import("./browser")).getClickBusBrowserSession()
      : await getClickBusSession();

  if (origemOuUrl.startsWith("http")) {
    const url = new URL(origemOuUrl);
    const parts = url.pathname.split("/").filter(Boolean);
    if (
      !["clickbus.com.br", "www.clickbus.com.br"].includes(url.hostname) ||
      parts.length !== 3 ||
      parts[0] !== "onibus"
    )
      throw new Error("LOCATION_NOT_FOUND");
    const from = routeSlugParts(parts[1]),
      to = routeSlugParts(parts[2]);
    return session.buscarData(
      from.city,
      from.uf,
      to.city,
      to.uf,
      url.searchParams.get("departureDate") ?? "",
      url.searchParams.get("gratuity") === "true",
    );
  }

  return session.buscarData(
    origemOuUrl,
    origemUF,
    destino,
    destinoUF,
    data,
    idJovem,
  );
}

export { ClickBusSession, getClickBusSession };
