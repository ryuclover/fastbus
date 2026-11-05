export type ProviderMoneySource =
  | "ClickBus"
  | "Guanabara"
  | "Mobifacil"
  | "Embarca"
  | "AguiaBranca"
  | "Buser"
  | "generic";

/**
 * Parses monetary values into integer cents safely (Number.isSafeInteger).
 * Rejects non-finite numbers, negative values, excessive precision (> 2 decimal places),
 * and ambiguous string formats (e.g. thousand separators without decimals).
 */
export function parseProviderMoney(
  value: unknown,
  provider: ProviderMoneySource = "generic",
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    const rounded = Math.round(value * 100);
    if (!Number.isSafeInteger(rounded)) return null;
    // Check scale: reject more than 2 decimal places (excessive precision like 10.125)
    // Avoid floating point jitter: Math.abs(rounded / 100 - value) must be practically 0
    if (Math.abs(rounded / 100 - value) > 1e-6) return null;
    return rounded;
  }

  if (typeof value !== "string") {
    return null;
  }

  let raw = value.trim();
  if (!raw) return null;

  // Optional BRL currency prefix: "R$", "R$ ", "BRL", "BRL "
  if (raw.startsWith("R$")) {
    raw = raw.slice(2).trim();
  } else if (raw.startsWith("BRL")) {
    raw = raw.slice(3).trim();
  }

  // Reject negative numbers or special strings
  if (raw.startsWith("-") || raw === "NaN" || raw === "Infinity") {
    return null;
  }

  // Pure integer: "0", "100"
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) return null;
    const cents = n * 100;
    return Number.isSafeInteger(cents) ? cents : null;
  }

  // Brazilian format with comma: "123,45", "0,00", "1.234,56", "12.345,67"
  // Note: rejects "1.234" (ambiguous thousand dot without decimal comma)
  const brazilianWithThousands = /^\d{1,3}(?:\.\d{3})+,\d{1,2}$/;
  const brazilianSimple = /^\d+,\d{1,2}$/;

  // Dot decimal format (standard in JSON APIs): "123.45", "55.5", "0.00"
  const dotDecimal = /^\d+\.\d{1,2}$/;

  let intStr = "";
  let fracStr = "";

  if (brazilianWithThousands.test(raw)) {
    const parts = raw.split(",");
    intStr = parts[0].replace(/\./g, "");
    fracStr = parts[1];
  } else if (brazilianSimple.test(raw)) {
    const parts = raw.split(",");
    intStr = parts[0];
    fracStr = parts[1];
  } else if (dotDecimal.test(raw)) {
    const parts = raw.split(".");
    intStr = parts[0];
    fracStr = parts[1];
  } else {
    // Unrecognized or ambiguous format
    return null;
  }

  const intPart = Number(intStr);
  if (!Number.isSafeInteger(intPart)) return null;

  const fracPadded = (fracStr + "00").slice(0, 2);
  const fracPart = Number(fracPadded);
  const cents = intPart * 100 + fracPart;

  return Number.isSafeInteger(cents) ? cents : null;
}

/** Convenience alias returning integer cents */
export function parseMoneyCents(
  value: unknown,
  provider: ProviderMoneySource = "generic",
): number | null {
  return parseProviderMoney(value, provider);
}

/** Format cents into Brazilian currency string (e.g. 1013 -> "R$ 10,13") */
export function formatMoneyBrl(cents: number): string {
  if (!Number.isSafeInteger(cents) || cents < 0) return "R$ 0,00";
  const whole = Math.floor(cents / 100);
  const frac = (cents % 100).toString().padStart(2, "0");
  const wholeFormatted = whole
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `R$ ${wholeFormatted},${frac}`;
}

export function brlCents(value: number): number | null {
  return parseProviderMoney(value);
}

/** Records saved before the cents field was introduced carry only price in BRL. */
export function priceInReais(item: { price: number; priceMinor?: number }) {
  return item.priceMinor === undefined ? item.price : item.priceMinor / 100;
}

export function comparableCents(item: {
  valorNumerico?: number;
  priceMinor?: number;
  evidence?: { totalMinor: number | null };
}) {
  const amount =
    item.evidence?.totalMinor ??
    item.priceMinor ??
    (item.valorNumerico === undefined
      ? null
      : parseProviderMoney(item.valorNumerico));
  return amount !== null && Number.isSafeInteger(amount) && amount >= 0
    ? amount
    : null;
}
