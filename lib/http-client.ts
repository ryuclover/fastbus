import { monitoredFetch } from "./monitoring/request-budget";

/** One attempt only. The monitoring scheduler owns retries and provider backoff. */
export async function fetchWithRetry(
  url: string,
  options: RequestInit & { timeoutMs?: number } = {},
  _retries = 1,
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 12000;
  return monitoredFetch(url, { ...options, timeoutMs, cache: "no-store" });
}
