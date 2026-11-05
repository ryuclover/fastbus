// Only resolve a civil time when the query identifies an unambiguous zone.
const zones: Record<string, string> = {
  SP: "America/Sao_Paulo",
  RJ: "America/Sao_Paulo",
  MG: "America/Sao_Paulo",
  ES: "America/Sao_Paulo",
  PR: "America/Sao_Paulo",
  SC: "America/Sao_Paulo",
  RS: "America/Sao_Paulo",
  DF: "America/Sao_Paulo",
  GO: "America/Sao_Paulo",
  BA: "America/Bahia",
  CE: "America/Fortaleza",
  PI: "America/Fortaleza",
  MA: "America/Fortaleza",
  RN: "America/Fortaleza",
  PB: "America/Fortaleza",
  AL: "America/Maceio",
  SE: "America/Maceio",
  TO: "America/Araguaina",
  MS: "America/Campo_Grande",
  MT: "America/Cuiaba",
  AC: "America/Rio_Branco",
  RR: "America/Boa_Vista",
  RO: "America/Porto_Velho",
  AP: "America/Belem",
};
export function originZone(city: string | null) {
  if (!city) return null;
  const [name, uf] = city.split(/::| - /);
  if (uf === "AM" && name === "Manaus") return "America/Manaus";
  if (uf === "PE" && name === "Recife") return "America/Recife";
  if (uf === "PA" && /^bel[eé]m$/i.test(name)) return "America/Belem";
  return zones[uf] ?? null;
}
