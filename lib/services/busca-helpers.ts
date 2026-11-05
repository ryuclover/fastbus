import { NextRequest } from "next/server"
import { cidadesSugeridas } from "@/lib/cidades-sugeridas"
import { ResultItem } from "@/lib/scrapers/types"
import type { Passagem as BasePassagem } from "@/types/busca"

export interface Passagem extends BasePassagem {
  vagasIdJovem100: number
}

interface RegistroRateLimit {
  count: number
  resetAt: number
}

const RATE_LIMIT_WINDOW_MS = 60_000
const RATE_LIMIT_MAX_REQUESTS = 60 // Ajustado para suportar fan-out paralelo
const MAX_DATA_BUSCA_DIAS = 365
const MAX_USER_AGENT_LENGTH = 120
const MS_POR_DIA = 24 * 60 * 60 * 1000

const registrosRateLimit = new Map<string, RegistroRateLimit>()
let proximaLimpezaRateLimit = 0

export function normalizarTexto(valor: string): string {
  return valor
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
}

export function montarChaveCidade(nome: string, uf: string): string {
  return `${normalizarTexto(nome)}::${uf.trim().toUpperCase()}`
}

const cidadesPermitidas = new Set(
  cidadesSugeridas.map((cidade) => montarChaveCidade(cidade.nome, cidade.uf))
)

export function validarCidadePermitida(nome: string, uf: string): boolean {
  return cidadesPermitidas.has(montarChaveCidade(nome, uf))
}

export function obterIpDaRequisicao(request: NextRequest): string | null {
  const forwardedFor = request.headers.get("x-forwarded-for")
  if (forwardedFor) {
    const primeiroIp = forwardedFor.split(",")[0]?.trim()
    if (primeiroIp) return primeiroIp
  }

  const realIp = request.headers.get("x-real-ip")
  if (realIp) return realIp

  if (process.env.NODE_ENV === "production") return null

  const userAgent = request.headers.get("user-agent")?.trim() || "sem-identificacao"
  return `dev:${userAgent.toLowerCase().slice(0, MAX_USER_AGENT_LENGTH)}`
}

export function validarRateLimit(ip: string): boolean {
  const agora = Date.now()

  if (agora >= proximaLimpezaRateLimit) {
    for (const [chave, registro] of registrosRateLimit.entries()) {
      if (registro.resetAt <= agora) registrosRateLimit.delete(chave)
    }
    proximaLimpezaRateLimit = agora + RATE_LIMIT_WINDOW_MS
  }

  const atual = registrosRateLimit.get(ip)
  if (!atual || atual.resetAt <= agora) {
    registrosRateLimit.set(ip, { count: 1, resetAt: agora + RATE_LIMIT_WINDOW_MS })
    return true
  }

  if (atual.count >= RATE_LIMIT_MAX_REQUESTS) return false

  atual.count += 1
  registrosRateLimit.set(ip, atual)
  return true
}

export function validarDataBusca(data: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) return false

  const dataSolicitada = new Date(`${data}T00:00:00.000Z`)
  if (Number.isNaN(dataSolicitada.getTime())) return false

  const [ano, mes, dia] = data.split("-").map((segmento) => Number.parseInt(segmento, 10))
  if (
    dataSolicitada.getUTCFullYear() !== ano ||
    dataSolicitada.getUTCMonth() + 1 !== mes ||
    dataSolicitada.getUTCDate() !== dia
  ) {
    return false
  }

  const hoje = new Date()
  const hojeUtc = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate())
  const maxUtc = hojeUtc + MAX_DATA_BUSCA_DIAS * MS_POR_DIA
  const dataUtc = Date.UTC(
    dataSolicitada.getUTCFullYear(),
    dataSolicitada.getUTCMonth(),
    dataSolicitada.getUTCDate()
  )

  // Tolerância de 1 dia para trás para cobrir fuso horário brasileiro (UTC-3)
  const minPermitido = hojeUtc - MS_POR_DIA
  return dataUtc >= minPermitido && dataUtc <= maxUtc
}

export function converterItemParaPassagem(item: ResultItem, siteFallback = "FastBus"): Passagem {
  const site = item.empresa || siteFallback
  return {
    id: `${site}-${item.data}-${Math.random().toString(36).slice(2, 11)}`,
    empresa: item.empresa,
    site,
    siteUrl: item.linkCompra || "",
    origem: item.origem || "",
    destino: item.destino || "",
    data: item.data || "",
    partida: item.horario || "N/A",
    chegada: item.chegada || "N/A",
    duracao: item.duracao || "Consulte site",
    valor: item.valor,
    valorNumerico: item.valorNumerico,
    classe: item.classe,
    tipoGratuidade: item.tipoGratuidade,
    modalidadeGratuidade:
      item.linkCompra?.includes("viajeguanabara") ||
      item.linkCompra?.includes("embarca") ||
      item.linkCompra?.includes("aguiabranca") ||
      item.linkCompra?.includes("clickbus")
        ? "online"
        : "guiche",
    vagasIdJovem: item.vagasIdJovem ?? 0,
    vagasIdJovem100:
      item.tipoGratuidade === "id_jovem_100" || item.valorNumerico === 0 || item.valor === "R$ 0,00"
        ? item.vagasIdJovem ?? 2
        : 0,
    linkCompra: item.linkCompra || "",
    avisoAssento: item.avisoAssento,
  }
}
