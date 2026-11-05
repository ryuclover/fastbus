export interface Passagem {
  id: string
  empresa: string
  site: string
  siteUrl: string
  origem: string
  destino: string
  data: string // YYYY-MM-DD
  partida: string // HH:MM
  chegada: string // HH:MM
  duracao: string
  valor?: string
  valorNumerico?: number
  classe?: string
  tipoGratuidade?: "id_jovem_100" | "id_jovem_50" | "nenhuma"
  modalidadeGratuidade?: "online" | "guiche"
  vagasIdJovem: number
  vagasIdJovem100?: number
  linkCompra: string
  avisoAssento?: string
}

export interface ResumoDia {
  data: string
  menorValor?: number
  temIdJovem100: boolean
  temIdJovem50: boolean
  totalViagens: number
  empresaMenorValor?: string
  horarioMenorValor?: string
}

export interface ResultadoBusca {
  buscadoEm: string
  origem: string
  destino: string
  dataSolicitada: string
  datasConsultadas?: string[]
  dataTemIdJovem?: boolean
  fontesIgnoradas?: string[]
  passagensNaData: Passagem[]
  passagensProximas: Passagem[]
  totalEncontrado: number
  melhorDataPeriodo?: string
  menorPrecoPeriodo?: number
  empresaCampeaoPeriodo?: string
  resumoPorDia?: ResumoDia[]
  statusProvedores?: StatusProvedorBusca[]
}

export type { ProvedorId as ProvedorBusca } from "./providers"

export type StatusProvedor = "online" | "sem_oferta" | "inconclusivo" | "sem_cobertura" | "erro" | "consultando"

export interface StatusProvedorBusca {
  provedor: string
  status: StatusProvedor
  detalhes: string
}

export interface BlocoData {
  data: string
  passagens: Passagem[]
}

export type TipoOrdenacao = "valor" | "partida" | "duracao" | "padrao"
export type TipoTurno = "todos" | "manha" | "tarde" | "noite"

export interface FiltrosBusca {
  ordenacao: TipoOrdenacao
  empresa: string
  turno: TipoTurno
  apenasIdJovem: boolean
  apenas100?: boolean
  dataFoco?: string
}
