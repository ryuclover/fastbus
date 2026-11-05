import { chromium } from "playwright"
import fs from "fs"
import path from "path"

/**
 * Script Playwright para mapear e registrar as requisições de rede da Guanabara.
 * Execução: npx tsx lib/scrapers/guanabara/mapper.ts
 */
export async function mapGuanabara(
  origemSlug = "rio_de_janeiro-rj-todos",
  destinoSlug = "sao_paulo-sp-todos",
  data = "2026-09-25",
  idJovem = true
) {
  console.log(`[Guanabara Mapper] Iniciando mapeamento para ${origemSlug} -> ${destinoSlug} em ${data} (ID Jovem: ${idJovem})...`)

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  })

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1366, height: 768 },
    locale: "pt-BR",
  })

  const page = await context.newPage()
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined })
  })

  const capturedEndpoints: any[] = []

  page.on("request", (req) => {
    const url = req.url()
    if (
      url.includes("viajeguanabara.com.br") &&
      (url.includes("api") || url.includes("trip") || url.includes("cota") || url.includes("_next/data"))
    ) {
      console.log(`🎯 [Guanabara API Request] ${req.method()} ${url}`)
      capturedEndpoints.push({
        url,
        method: req.method(),
        headers: req.headers(),
      })
    }
  })

  page.on("response", async (res) => {
    const url = res.url()
    if (url.includes("api") || url.includes("trip") || url.includes("cota") || url.includes("_next/data")) {
      try {
        await res.json()
        console.log(`📦 [Guanabara API Response] ${url} retornou JSON!`)
      } catch (e) {}
    }
  })

  // URL padrão da Guanabara com ID Jovem (passengers=13:1)
  const targetUrl = `https://viajeguanabara.com.br/onibus/${origemSlug}/${destinoSlug}/?departure_date=${data}&passengers=${idJovem ? "13:1" : "1"}`
  console.log(`🌐 Navegando para: ${targetUrl}`)

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 40000 })
    await page.waitForTimeout(6000)

    const outputDir = path.resolve(process.cwd(), "lib/scrapers/guanabara")
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true })
    const outputFile = path.join(outputDir, "mapped-api.json")

    fs.writeFileSync(
      outputFile,
      JSON.stringify(
        {
          capturedAt: new Date().toISOString(),
          targetUrl,
          totalEndpoints: capturedEndpoints.length,
          endpoints: capturedEndpoints,
        },
        null,
        2
      )
    )

    console.log(`\n✅ [Guanabara Mapper] Mapeamento salvo em: ${outputFile}`)
  } catch (error) {
    console.error("❌ [Guanabara Mapper] Erro:", error)
  } finally {
    await browser.close()
  }
}

if (require.main === module || process.argv[1]?.includes("mapper.ts")) {
  mapGuanabara().catch(console.error)
}
