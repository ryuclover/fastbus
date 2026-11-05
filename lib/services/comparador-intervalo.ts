import { comparableCents } from "../money"
import {
  ResultItem,
  ScraperResult,
  ResultadoComparacaoIntervalo,
  ResumoDia,
  StatusProvedorBusca,
} from "../scrapers/types"
import { obterAdaptadores, type ProvedorId } from "./provedores"

export interface CompararIntervaloParams {
  origem: string
  origemUF: string
  destino: string
  destinoUF: string
  dataInicio: string // YYYY-MM-DD
  dataFim: string // YYYY-MM-DD
  idJovem?: boolean
  apenas100?: boolean
  provedores?: ProvedorId[]
  maxConcorrencia?: number
  timeoutMs?: number
}

const TIMEOUT_PROVEDOR_MS = 10_000

function gerarListaDatas(dataInicio: string, dataFim: string): string[] {
  const inicio = new Date(`${dataInicio}T00:00:00`)
  const fim = new Date(`${dataFim}T00:00:00`)
  const datas: string[] = []

  if (isNaN(inicio.getTime()) || isNaN(fim.getTime()) || inicio > fim) {
    return [dataInicio]
  }

  const atual = new Date(inicio)
  while (atual <= fim) {
    datas.push(atual.toISOString().split("T")[0])
    atual.setDate(atual.getDate() + 1)
  }

  return datas
}

/**
 * Utilitário para executar promessas em lotes com concorrência controlada.
 */
async function mapConcorrente<T, R>(
  itens: T[],
  limite: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const resultados: R[] = []
  for (let i = 0; i < itens.length; i += limite) {
    const lote = itens.slice(i, i + limite)
    const resLote = await Promise.all(lote.map(fn))
    resultados.push(...resLote)
  }
  return resultados
}

async function executarComTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("PROVIDER_TIMEOUT")), timeoutMs)
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timeoutId) clearTimeout(timeoutId)
  }
}

export async function compararPrecosIntervalo(
  params: CompararIntervaloParams
): Promise<ResultadoComparacaoIntervalo> {
  const {
    origem,
    origemUF,
    destino,
    destinoUF,
    dataInicio,
    dataFim,
    idJovem = false,
    apenas100 = false,
    provedores = ["ClickBus", "Gontijo", "Guanabara", "Buser", "Embarca", "AguiaBranca", "Mobifacil"],
    maxConcorrencia = 1,
    timeoutMs = TIMEOUT_PROVEDOR_MS,
  } = params

  const datas = gerarListaDatas(dataInicio, dataFim)
  const todasViagens: ResultItem[] = []
  const resumoPorDia: ResumoDia[] = []
  const statusPorProvedor = new Map<string, StatusProvedorBusca>()

  // Consulta por data com controle de concorrência
  const resultadosPorData = await mapConcorrente(
    datas,
    maxConcorrencia,
    async (dataIso) => {
      const tarefasProvedores: Array<() => Promise<ScraperResult>> = obterAdaptadores(provedores, idJovem).map((adaptador) => () =>
        executarComTimeout(
          adaptador.consultar({ origem, origemUF, destino, destinoUF, dataIso, idJovem }),
          timeoutMs
        ).catch((err) => ({
          disponivel: false,
          vagasIdJovem: 0,
          detalhes: err?.message === "PROVIDER_TIMEOUT"
            ? `${adaptador.id} demorou para responder nesta data.`
            : `Consulta indisponível para ${adaptador.id}`,
          siteUrl: "",
          provedor: adaptador.id,
          dataConsultada: dataIso,
          resultados: [],
          error: String(err),
        }))
      )

      const resultadosProvedores: ScraperResult[] = await Promise.all(
        tarefasProvedores.map((tarefa) => tarefa())
      )
      let viagensDoDia: ResultItem[] = []

      for (const res of resultadosProvedores) {
        if (res.disponivel && res.resultados.length > 0) {
          for (const item of res.resultados) {
            viagensDoDia.push({
              ...item,
              data: dataIso,
              origem: `${origem} - ${origemUF}`,
              destino: `${destino} - ${destinoUF}`,
              linkCompra: item.linkCompra || res.siteUrl,
            })
          }
        }
      }

      for (const res of resultadosProvedores) {
        const provedorKey = res.provedor === "Embarca.ai" ? "Embarca" : res.provedor
        const isTimeout =
          res.error === "PROVIDER_TIMEOUT" ||
          (typeof res.error === "string" && (res.error.includes("TIMEOUT") || res.error.includes("aborted")))
        const status = res.error === "COVERAGE_NOT_IMPLEMENTED"
          ? "sem_cobertura"
          : res.outcome === "manual" || res.outcome === "partial" || res.error === "BFF_NO_RESPONSE"
            ? "inconclusivo"
          : res.resultados.length > 0
            ? "online"
          : isTimeout
            ? "erro"
          : res.error
            ? "erro"
          : "sem_oferta"
        const anterior = statusPorProvedor.get(provedorKey)
        const prioridadeStatus: Record<string, number> = {
          sem_oferta: 1,
          sem_cobertura: 2,
          inconclusivo: 3,
          erro: 4,
          online: 5,
        }
        if (!anterior || prioridadeStatus[status] > prioridadeStatus[anterior.status]) {
          statusPorProvedor.set(provedorKey, {
            provedor: provedorKey,
            status,
            detalhes: res.detalhes,
          })
        }
      }

      if (idJovem && apenas100) {
        viagensDoDia = viagensDoDia.filter(
          (v) =>
            v.tipoGratuidade === "id_jovem_100" && !!v.evidence?.benefitEvidence
        )
      }

      return { dataIso, viagensDoDia }
    }
  )

  let menorPrecoPeriodoMinor: number | undefined = undefined
  let melhorDataPeriodo: string | undefined = undefined
  let empresaCampeaoPeriodo: string | undefined = undefined

  for (const { dataIso, viagensDoDia } of resultadosPorData) {
    todasViagens.push(...viagensDoDia)

    let menorValorDiaMinor: number | undefined = undefined
    let empresaMenorValor: string | undefined = undefined
    let horarioMenorValor: string | undefined = undefined
    let temIdJovem100 = false
    let temIdJovem50 = false

    for (const v of viagensDoDia) {
      const is100 =
        v.tipoGratuidade === "id_jovem_100" && !!v.evidence?.benefitEvidence

      if (is100) {
        temIdJovem100 = true
      }
      if (v.tipoGratuidade === "id_jovem_50") {
        temIdJovem50 = true
      }

      const cents=comparableCents(v)
      if (cents !== null) {
        if (menorValorDiaMinor === undefined || cents < menorValorDiaMinor) {
          menorValorDiaMinor = cents
          empresaMenorValor = v.empresa
          horarioMenorValor = v.horario
        }
      }
    }

    resumoPorDia.push({
      data: dataIso,
      menorValor: menorValorDiaMinor === undefined ? undefined : menorValorDiaMinor / 100,
      temIdJovem100,
      temIdJovem50,
      totalViagens: viagensDoDia.length,
      empresaMenorValor,
      horarioMenorValor,
    })

    // Avalia o campeão geral do período
    if (menorValorDiaMinor !== undefined) {
      if (menorPrecoPeriodoMinor === undefined || menorValorDiaMinor < menorPrecoPeriodoMinor) {
        menorPrecoPeriodoMinor = menorValorDiaMinor
        melhorDataPeriodo = dataIso
        empresaCampeaoPeriodo = empresaMenorValor
      }
    }
  }

  // Ordenação de todas as viagens: data crescente, e dentro do mesmo dia, menor valor primeiro
  todasViagens.sort((a, b) => {
    if (a.data !== b.data && a.data && b.data) {
      return a.data.localeCompare(b.data)
    }
    const valA = comparableCents(a) ?? Infinity
    const valB = comparableCents(b) ?? Infinity
    return valA - valB
  })

  return {
    origem: `${origem} - ${origemUF}`,
    destino: `${destino} - ${destinoUF}`,
    dataInicio,
    dataFim,
    idJovemApenas: idJovem,
    melhorDataPeriodo,
    menorPrecoPeriodo: menorPrecoPeriodoMinor === undefined ? undefined : menorPrecoPeriodoMinor/100,
    empresaCampeaoPeriodo,
    resumoPorDia,
    todasViagens,
    totalViagensEncontradas: todasViagens.length,
    statusProvedores: Array.from(statusPorProvedor.values()),
  }
}
