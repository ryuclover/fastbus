import { PROVIDER_CAPABILITIES, type ProvedorId } from "../../types/providers";

export function supportsMonitoring(provider: string, benefit: string) {
  if (!Object.hasOwn(PROVIDER_CAPABILITIES, provider)) return false;
  const capability = PROVIDER_CAPABILITIES[provider as ProvedorId];
  return benefit === "any"
    ? capability.hasCommercialInventory
    : capability.hasVerifiedQuota;
}
export const capabilityMessage =
  "Esta fonte não confirma automaticamente a disponibilidade para o benefício escolhido.";
