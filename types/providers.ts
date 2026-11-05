export const providerIds = [
  "ClickBus",
  "Guanabara",
  "Buser",
  "Gontijo",
  "Embarca",
  "AguiaBranca",
  "Mobifacil",
] as const;

export type ProvedorId = (typeof providerIds)[number];

export interface ProviderCapability {
  id: ProvedorId;
  name: string;
  hasCommercialInventory: boolean;
  hasVerifiedQuota: boolean;
  supportsOnlineBooking: boolean;
  isManualGuidanceOnly: boolean;
  supportsIdJovemSearch: boolean;
  requiresBrowser: boolean;
  description: string;
}

export const PROVIDER_CAPABILITIES: Record<ProvedorId, ProviderCapability> = {
  ClickBus: {
    id: "ClickBus",
    name: "ClickBus",
    hasCommercialInventory: true,
    hasVerifiedQuota: true,
    supportsOnlineBooking: true,
    isManualGuidanceOnly: false,
    supportsIdJovemSearch: true,
    requiresBrowser: false,
    description:
      "Inventário comercial completo e cotas ID Jovem (100% e 50%) verificáveis por viagem.",
  },
  Guanabara: {
    id: "Guanabara",
    name: "Guanabara",
    hasCommercialInventory: true,
    hasVerifiedQuota: true,
    supportsOnlineBooking: true,
    isManualGuidanceOnly: false,
    supportsIdJovemSearch: true,
    requiresBrowser: false,
    description:
      "Serviços e mapas de assentos com cota ID Jovem verificada para classe convencional.",
  },
  Mobifacil: {
    id: "Mobifacil",
    name: "Mobifácil",
    hasCommercialInventory: true,
    hasVerifiedQuota: false,
    supportsOnlineBooking: true,
    isManualGuidanceOnly: false,
    supportsIdJovemSearch: false,
    requiresBrowser: false,
    description:
      "Inventário comercial estruturado via parser lsServicos. Cotas de gratuidade não auditadas via API.",
  },
  Embarca: {
    id: "Embarca",
    name: "Embarca",
    hasCommercialInventory: true,
    hasVerifiedQuota: true,
    supportsOnlineBooking: true,
    isManualGuidanceOnly: false,
    supportsIdJovemSearch: true,
    requiresBrowser: false,
    description:
      "Inventário comercial via schema de viagens. Cota ID Jovem quando a fonte informa categoria, vagas e preço na mesma opção.",
  },
  AguiaBranca: {
    id: "AguiaBranca",
    name: "Águia Branca",
    hasCommercialInventory: true,
    hasVerifiedQuota: false,
    supportsOnlineBooking: true,
    isManualGuidanceOnly: false,
    supportsIdJovemSearch: false,
    requiresBrowser: false,
    description:
      "Consulta comercial via HTML/dataLayer. Modo ID Jovem orientativo para portal oficial.",
  },
  Gontijo: {
    id: "Gontijo",
    name: "Gontijo",
    hasCommercialInventory: false,
    hasVerifiedQuota: false,
    supportsOnlineBooking: false,
    isManualGuidanceOnly: true,
    supportsIdJovemSearch: false,
    requiresBrowser: false,
    description:
      "Orientação manual com link parametrizado para portal oficial JVVN. Não consulta inventário.",
  },
  Buser: {
    id: "Buser",
    name: "Buser",
    hasCommercialInventory: true,
    hasVerifiedQuota: false,
    supportsOnlineBooking: true,
    isManualGuidanceOnly: false,
    supportsIdJovemSearch: false,
    requiresBrowser: false,
    description:
      "Fretamento colaborativo e marketplace comercial. Não opera concessões ANTT / ID Jovem.",
  },
};
