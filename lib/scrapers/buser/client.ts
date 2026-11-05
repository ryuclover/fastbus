import { commercialCard } from "../raw-contracts";
import { ResultItem, ScraperResult } from "../types";
import { fetchWithRetry } from "../../http-client";
import { isMonitoringRequest } from "../../monitoring/request-budget";

function normalizarSlugBuser(cidade: string, uf: string): string {
  const clean = cidade
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9-]/g, "");
  return `${clean}-${uf.toLowerCase()}`;
}

function extrairViagensDoHtml(html: string, urlCompra: string) {
  const resultados: ResultItem[] = [];
  const blocos = html.split(/grupo-novo-card/).slice(1);

  let rejected = 0;
  if (blocos.length > 1000) throw new Error("PROVIDER_INVALID_RESPONSE");
  for (const bloco of blocos) {
    const precoMatch = bloco.match(
      /p-preco[^>]*>(?:[^<]*<[^>]+>)*\s*R\$\s*([\d.,]+)/,
    );
    const horarios = [...bloco.matchAll(/ird-hora[^>]*>(\d{2}:\d{2})</g)].map(
      (match) => match[1],
    );
    if (!precoMatch || horarios.length < 2) {
      rejected++;
      continue;
    }

    const precoTexto = precoMatch[1];
    if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{2})?$/.test(precoTexto)) {
      rejected++;
      continue;
    }
    const precoNumerico = Number(
      precoTexto.replace(/\./g, "").replace(",", "."),
    );
    if (
      !commercialCard.safeParse({
        price: precoNumerico,
        departure: horarios[0],
        arrival: horarios[1],
      }).success
    ) {
      rejected++;
      continue;
    }

    const duracaoMatch = bloco.match(/duracao-ida="(\d+)"/);
    const duracaoMinutos = duracaoMatch
      ? Math.round(Number(duracaoMatch[1]) / 60000)
      : 0;
    const duracao = duracaoMinutos
      ? `${Math.floor(duracaoMinutos / 60)}h${String(duracaoMinutos % 60).padStart(2, "0")}min`
      : undefined;

    resultados.push({
      empresa: "Buser",
      horario: horarios[0],
      chegada: horarios[1],
      duracao,
      valor: `R$ ${precoNumerico.toFixed(2).replace(".", ",")}`,
      valorNumerico: precoNumerico,
      classe: /executivo/i.test(bloco) ? "Executivo" : undefined,
      tipoGratuidade: "nenhuma",
      vagasIdJovem: 0,
      linkCompra: urlCompra,
    });
  }

  const unicos = new Map<string, ResultItem>();
  for (const resultado of resultados) {
    const chave = `${resultado.horario}-${resultado.chegada}-${resultado.valorNumerico}-${resultado.classe}`;
    if (!unicos.has(chave)) unicos.set(chave, resultado);
  }
  return {
    resultados: Array.from(unicos.values()),
    coverage: {
      candidates: blocos.length,
      checked: blocos.length,
      unconfirmed: rejected,
      partial: rejected > 0,
    },
  };
}

export class BuserSession {
  private browser: any = null;
  private context: any = null;

  async init() {
    if (!this.browser) {
      try {
        const isServerless = process.platform === "linux";
        const { chromium: playwrightChromium } = isServerless
          ? await import("playwright-core")
          : await import("playwright");
        const chromium = isServerless
          ? (await import("@sparticuz/chromium")).default
          : null;
        const launchOptions = isServerless
          ? {
              args: chromium!.args,
              executablePath: await chromium!.executablePath(),
              headless: true,
            }
          : {
              args: [
                "--no-sandbox",
                "--disable-blink-features=AutomationControlled",
              ],
              headless: true,
            };

        this.browser = await playwrightChromium.launch(launchOptions);
        this.context = await this.browser.newContext({
          userAgent:
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          viewport: { width: 1280, height: 800 },
        });
        await this.context.route("**/*", (route: any) => {
          const type = route.request().resourceType();
          if (["image", "font", "media"].includes(type)) {
            return route.abort();
          }
          return route.continue();
        });
      } catch (err) {
        console.error(
          "[Buser] Não foi possível iniciar o navegador de coleta:",
          err,
        );
        this.browser = null;
        this.context = null;
      }
    }
  }

  async buscarData(
    origem: string,
    origemUF: string,
    destino: string,
    destinoUF: string,
    dataIso: string,
    idJovem = false,
  ): Promise<ScraperResult> {
    // Buser é fretamento colaborativo / marketplace de fretados, logo não possui gratuidade governamental ID Jovem
    if (idJovem) {
      return {
        disponivel: false,
        vagasIdJovem: 0,
        detalhes:
          "Buser opera por fretamento colaborativo e não emite ID Jovem governamental.",
        siteUrl: "https://www.buser.com.br",
        provedor: "Buser",
        empresa: "Buser",
        dataConsultada: dataIso,
        resultados: [],
      };
    }

    const fromSlug = normalizarSlugBuser(origem, origemUF);
    const toSlug = normalizarSlugBuser(destino, destinoUF);
    const siteUrl = `https://www.buser.com.br/onibus/${fromSlug}/${toSlug}?ida=${dataIso}`;

    try {
      const response = await fetchWithRetry(siteUrl, {
        headers: {
          Accept: "text/html,application/xhtml+xml",
          Referer: "https://www.buser.com.br/",
        },
      });
      if (!response.ok) throw new Error("BUSER_HTTP_" + response.status);
      const { resultados, coverage } = extrairViagensDoHtml(
        await response.text(),
        siteUrl,
      );
      if (resultados.length > 0) {
        return {
          disponivel: true,
          coverage,
          vagasIdJovem: 0,
          detalhes: `${resultados.length} opção(ões) de fretamento encontradas na Buser para ${dataIso}`,
          siteUrl,
          provedor: "Buser",
          empresa: "Buser",
          dataConsultada: dataIso,
          resultados,
        };
      }
    } catch (err) {
      console.warn("[Buser] Falha no fallback HTML:", err);
    }

    if (isMonitoringRequest()) {
      return {
        disponivel: false,
        vagasIdJovem: 0,
        detalhes:
          "Buser sem dados confirmados na resposta HTTP. Consulta por navegador desativada no monitoramento.",
        siteUrl,
        provedor: "Buser",
        dataConsultada: dataIso,
        resultados: [],
        error: "NO_CONFIRMED_HTTP_DATA",
      };
    }
    await this.init();

    if (!this.context) {
      return {
        disponivel: false,
        vagasIdJovem: 0,
        detalhes: "Buser indisponível para consulta automática neste ambiente.",
        siteUrl,
        provedor: "Buser",
        empresa: "Buser",
        dataConsultada: dataIso,
        resultados: [],
        error: "BROWSER_INIT_FAILED",
      };
    }

    const page = await this.context!.newPage();

    try {
      await page.goto(siteUrl, {
        waitUntil: "domcontentloaded",
        timeout: 35000,
      });
      await page.waitForTimeout(4000);

      const trips = await page.evaluate((urlCompra: string) => {
        const results: any[] = [];
        const cardElements = document.querySelectorAll(
          ".grupo-novo-card, .itinerario-resumido-novo-card",
        );

        cardElements.forEach((el) => {
          const text = (el as HTMLElement).innerText || "";
          if (!text.includes("R$")) return;

          const times = text.match(/\b\d{2}:\d{2}\b/g) || [];
          const priceMatch = text.match(
            /R\$\s*((?:\d+|\d{1,3}(?:\.\d{3})+),\d{2})(?![.,\d])/,
          );
          const classeMatch = text.match(
            /\b(Leito Individual|Leito|Semileito|Semi-Leito|Executivo|Cama)\b/i,
          );
          const durationMatch = text.match(/\b\d+h\d*m*(?:in)?\b/i);

          if (times.length >= 2 && priceMatch) {
            const rawPrice = priceMatch[1].replace(/\./g, "").replace(",", ".");
            const priceNum = parseFloat(rawPrice);

            results.push({
              empresa: "Buser",
              horario: times[0],
              chegada: times[1],
              duracao: durationMatch ? durationMatch[0] : undefined,
              valor: `R$ ${rawPrice.replace(".", ",")}`,
              valorNumerico: priceNum,
              classe: classeMatch ? classeMatch[0] : undefined,
              linkCompra: urlCompra,
            });
          }
        });

        const uniqueMap = new Map();
        for (const r of results) {
          const key = `${r.horario}-${r.chegada}-${r.valorNumerico}-${r.classe}`;
          if (!uniqueMap.has(key)) {
            uniqueMap.set(key, r);
          }
        }
        return Array.from(uniqueMap.values());
      }, siteUrl);

      await page.close();

      if (trips.length > 1000) throw new Error("PROVIDER_INVALID_RESPONSE");
      const resultados: ResultItem[] = trips
        .filter(
          (t: any) =>
            commercialCard.safeParse({
              price: t.valorNumerico,
              departure: t.horario,
              arrival: t.chegada,
            }).success,
        )
        .map((t: any) => ({
          empresa: "Buser",
          horario: t.horario,
          chegada: t.chegada,
          duracao: t.duracao,
          valor: t.valor,
          valorNumerico: t.valorNumerico,
          classe: t.classe,
          tipoGratuidade: "nenhuma",
          vagasIdJovem: 0,
          origem: `${origem} - ${origemUF}`,
          destino: `${destino} - ${destinoUF}`,
          data: dataIso,
          linkCompra: siteUrl,
        }));

      return {
        coverage: {
          candidates: trips.length,
          checked: trips.length,
          unconfirmed: trips.length - resultados.length,
          partial: resultados.length < trips.length,
        },
        disponivel: resultados.length > 0,
        vagasIdJovem: 0,
        detalhes: `${resultados.length} opção(ões) de fretamento encontradas na Buser para ${dataIso}`,
        siteUrl,
        empresa: "Buser",
        provedor: "Buser",
        dataConsultada: dataIso,
        resultados,
      };
    } catch (err: any) {
      await page.close().catch(() => {});
      return {
        disponivel: false,
        vagasIdJovem: 0,
        detalhes: `Falha na consulta Buser: ${err?.message || err}`,
        siteUrl,
        empresa: "Buser",
        provedor: "Buser",
        dataConsultada: dataIso,
        resultados: [],
        error: err?.message || String(err),
      };
    }
  }

  async close() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
    }
  }
}

let globalBuserSession: BuserSession | null = null;

export async function getBuserSession(): Promise<BuserSession> {
  if (!globalBuserSession) {
    globalBuserSession = new BuserSession();
  }
  return globalBuserSession;
}

export async function scrapeBuser(
  origem: string,
  origemUF: string,
  destino: string,
  destinoUF: string,
  dataIso: string,
  idJovem = false,
): Promise<ScraperResult> {
  const session = await getBuserSession();
  return session.buscarData(
    origem,
    origemUF,
    destino,
    destinoUF,
    dataIso,
    idJovem,
  );
}
