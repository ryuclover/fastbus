export type ClickBusQuotas = {
  vagas100: number;
  vagas50: number;
  preco100?: number;
  preco50?: number;
};

export { isChallengeHtml as isClickBusChallengeHtml } from "../../monitoring/response-policy";

import { parseProviderMoney } from "../../money";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function price(value: unknown): number | undefined {
  const cents = parseProviderMoney(value, "ClickBus");
  return cents === null ? undefined : cents / 100;
}
function quota(value: unknown) {
  const item = record(value);
  if (!item) return null;
  const rawCount = Object.hasOwn(item, "availableSeats")
    ? item.availableSeats
    : item.amount;
  const count =
    typeof rawCount === "string" && /^\d+$/.test(rawCount)
      ? Number(rawCount)
      : rawCount;
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    return null;
  return { count, price: price(item.price) };
}
export function parseClickBusQuotas(value: unknown): ClickBusQuotas | null {
  const discounts = record(value);
  if (!discounts) return null;
  const full = quota(discounts.youngIdFullPrice);
  const partial = quota(discounts.youngIdPartialPrice);
  if (!full && !partial) return null;
  return {
    vagas100: full?.count ?? 0,
    vagas50: partial?.count ?? 0,
    preco100: full?.price,
    preco50: partial?.price,
  };
}

/** Read a balanced JSON value without changing escapes inside quoted strings. */
function jsonEnd(text: string, start: number) {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index++) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quoted && char === "\\") {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (char === "{" || char === "[") depth++;
    if (char === "}" || char === "]") {
      if (--depth === 0) return index + 1;
    }
  }
  return -1;
}

function pageChunks(html: string) {
  if (html.length > 8 * 1024 * 1024) return [];
  const chunks = [html];
  // Next App Router embeds JSON inside a JSON-encoded RSC string.
  for (const match of html.matchAll(/self\.__next_f\.push\(\s*(\[)/g)) {
    const start = match.index! + match[0].length - 1;
    const end = jsonEnd(html, start);
    if (end === -1) break;
    try {
      const data: unknown = JSON.parse(html.slice(start, end));
      if (Array.isArray(data) && typeof data[1] === "string")
        chunks.push(data[1]);
    } catch {
      /* Incomplete or non-JSON script: no availability evidence. */
    }
  }
  return chunks;
}

/** Only an online benefit flow tied to this exact trip can confirm availability. */
export function parseClickBusTripPage(
  html: string,
  tripId: string,
): ClickBusQuotas | null {
  const found: ClickBusQuotas[] = [];
  for (const chunk of pageChunks(html)) {
    for (const match of chunk.matchAll(/"trips"\s*:\s*\[/g)) {
      const start = match.index! + match[0].length - 1;
      const end = jsonEnd(chunk, start);
      if (end === -1) break;
      try {
        const trips: unknown = JSON.parse(chunk.slice(start, end));
        if (!Array.isArray(trips)) continue;
        for (const value of trips) {
          const trip = record(value);
          if (!trip || trip.uuid !== tripId) continue;
          if (record(trip.travelCompany)?.hasGratuity !== true) return null;
          const discounts = record(trip.discounts);
          if (!discounts) return null;
          for (const [key, percentage] of [
            ["youngIdFullPrice", 100],
            ["youngIdPartialPrice", 50],
          ] as const) {
            const item = record(discounts[key]);
            if (
              item &&
              (item.type !== "YOUNG_ID" ||
                item.young !== true ||
                item.percentage !== percentage)
            )
              return null;
          }
          const parsed = parseClickBusQuotas(discounts);
          if (parsed) found.push(parsed);
        }
      } catch {
        /* An incomplete trip cannot confirm quotas. */
      }
    }
  }
  if (!found.length) return null;
  return found.every(
    (item) => JSON.stringify(item) === JSON.stringify(found[0]),
  )
    ? found[0]
    : null;
}

export function parseClickBusQuotasHtml(html: string): ClickBusQuotas | null {
  const found: ClickBusQuotas[] = [];
  for (const chunk of pageChunks(html)) {
    for (const match of chunk.matchAll(/"discounts"\s*:\s*\{/g)) {
      const start = match.index! + match[0].length - 1;
      const end = jsonEnd(chunk, start);
      if (end === -1) break;
      try {
        const parsed = parseClickBusQuotas(JSON.parse(chunk.slice(start, end)));
        if (parsed) found.push(parsed);
      } catch {
        /* Malformed JSON is not a zero-price ticket. */
      }
    }
  }
  if (!found.length) return null;
  // Conflicting embedded snapshots cannot identify the current quota safely.
  return found.every(
    (item) => JSON.stringify(item) === JSON.stringify(found[0]),
  )
    ? found[0]
    : null;
}
