export interface OfferStop {
  city: string | null;
  id: string | null;
  terminal: string | null;
}
export interface OfferEvidence {
  linkScope?: "trip" | "route";
  routeEvidence?: "provider" | "request" | "mixed";
  version: 1;
  id: string;
  provider: string;
  sourceTripId: string | null;
  observedAt: number;
  expiresAt: number;
  departureAt: number | null;
  arrivalAt?: number | null;
  timeZone: string | null;
  origin: OfferStop;
  destination: OfferStop;
  segments: Array<{ origin: OfferStop; destination: OfferStop }> | null;
  currency: "BRL";
  quotedMinor: number | null;
  fareMinor: number | null;
  feesMinor: number | null;
  totalMinor: number | null;
  benefitEvidence: {
    percentage?: 50 | 100;
    kind: "seat-map" | "checkout-quota" | "provider-quota";
    seats: number;
  } | null;
}
export type AcquisitionOutcome =
  "offers" | "empty" | "partial" | "manual" | "blocked" | "failed";

export interface ResultItem {
  evidence?: OfferEvidence;
  originStop?: OfferStop;
  destinationStop?: OfferStop;
  segments?: OfferEvidence["segments"];
  fareMinor?: number;
  feesMinor?: number;
  totalMinor?: number;
  /** Reported BRL price in integer cents, derived by the shared validator. */
  priceMinor?: number;
  providerTripId?: string;
  validUntil?: number;
  departureAt?: number;
  arrivalAt?: number;
  arrivalDate?: string;
  empresa: string;
  horario?: string;
  chegada?: string;
  duracao?: string;
  valor?: string;
  valorNumerico?: number;
  classe?: string;
  tipoGratuidade?: "id_jovem_100" | "id_jovem_50" | "nenhuma";
  vagasIdJovem?: number;
  poltronasLivres?: number;
  origem?: string;
  destino?: string;
  data?: string;
  linkCompra?: string;
  avisoAssento?: string;
}

export type ResultValidation = {
  version: 1;
  observedAt: number;
  received: number | null;
  accepted: number;
  rejected: number;
  state: "valid" | "partial" | "invalid";
};

export interface ScraperResult {
  outcome?: AcquisitionOutcome;
  coverage?: {
    unsupportedConnections?: number;
    candidates: number;
    checked: number;
    unconfirmed: number;
    partial: boolean;
  };
  validation?: ResultValidation;
  disponivel: boolean;
  vagasIdJovem: number;
  detalhes: string;
  siteUrl: string;
  empresa?: string;
  provedor: string;
  dataConsultada?: string;
  resultados: ResultItem[];
  error?: string;
}

export type StatusProvedor =
  "online" | "sem_oferta" | "inconclusivo" | "sem_cobertura" | "erro";

export interface StatusProvedorBusca {
  provedor: string;
  status: StatusProvedor;
  detalhes: string;
}

export interface ResumoDia {
  data: string;
  menorValor?: number;
  temIdJovem100: boolean;
  temIdJovem50: boolean;
  totalViagens: number;
  empresaMenorValor?: string;
  horarioMenorValor?: string;
}

export interface ResultadoComparacaoIntervalo {
  origem: string;
  destino: string;
  dataInicio: string;
  dataFim: string;
  idJovemApenas: boolean;
  melhorDataPeriodo?: string;
  menorPrecoPeriodo?: number;
  empresaCampeaoPeriodo?: string;
  resumoPorDia: ResumoDia[];
  todasViagens: ResultItem[];
  totalViagensEncontradas: number;
  statusProvedores: StatusProvedorBusca[];
}
