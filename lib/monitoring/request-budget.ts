import { AsyncLocalStorage } from "node:async_hooks";
import { setTimeout as delay } from "node:timers/promises";
import type { Dispatcher } from "undici";
import { providerProxyPool } from "./proxy";
import { requestSpacing } from "./pacing";
import {
  adaptiveDelay,
  challengeResponse,
  retryAfterMs,
} from "./response-policy";

export type RequestBudget = {
  count: number;
  lastAt: number;
  delayMs: number;
  blockedUntil: number;
  limited: boolean;
  tail: Promise<void>;
  signal: AbortSignal;
  dispatcher?: Dispatcher;
};
const budgets = new AsyncLocalStorage<RequestBudget>();
export const isMonitoringRequest = () => !!budgets.getStore();
export const remainingMonitoringRequests = () => {
  const budget = budgets.getStore();
  return budget ? Math.max(0, 8 - budget.count) : 8;
};
export const currentMonitoringBudget = () => budgets.getStore();
export function blockMonitoringRequests(
  retryMs = 15 * 60000,
  budget = budgets.getStore(),
) {
  if (budget)
    budget.blockedUntil = Math.max(
      budget.blockedUntil,
      Date.now() + Math.max(15 * 60000, retryMs),
    );
}
export async function withRequestBudget<T>(fn: () => Promise<T>) {
  const budget: RequestBudget = {
    count: 0,
    lastAt: 0,
    delayMs: 4000,
    blockedUntil: 0,
    limited: false,
    tail: Promise.resolve(),
    signal: AbortSignal.timeout(90_000),
    dispatcher: providerProxyPool().next(),
  };
  const result = await budgets.run(budget, fn);
  return { result, budget };
}
export async function runMonitoredRequest<T>(
  operation: () => Promise<T>,
  budget = budgets.getStore(),
): Promise<T> {
  if (!budget) return operation();
  const previous = budget.tail;
  let release!: () => void;
  budget.tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    if (budget.blockedUntil) throw new Error("PROVIDER_BLOCKED");
    if (budget.count >= 8) {
      budget.limited = true;
      throw new Error("PROVIDER_REQUEST_BUDGET");
    }
    await delay(
      Math.max(
        0,
        Math.max(requestSpacing(), budget.delayMs) -
          (Date.now() - budget.lastAt),
      ),
      undefined,
      {
        signal: budget.signal,
      },
    );
    budget.signal.throwIfAborted();
    budget.count++;
    const started = Date.now();
    let ok = false;
    try {
      const result = await operation();
      ok = true;
      return result;
    } finally {
      budget.delayMs = adaptiveDelay(budget.delayMs, Date.now() - started, ok);
      budget.lastAt = Date.now();
    }
  } finally {
    release();
  }
}

export function checkMonitoringResponse(
  status: number,
  retry: string | null,
  budget = budgets.getStore(),
  metadata: { challenge?: string | null; serverDate?: string | null } = {},
) {
  if (
    !budget ||
    (!(
      [401, 403, 408, 429].includes(status) ||
      (status >= 500 && status <= 599)
    ) &&
      metadata.challenge !== "challenge")
  )
    return;
  blockMonitoringRequests(retryAfterMs(retry, metadata.serverDate), budget);
  throw new Error("PROVIDER_BLOCKED");
}

/** Every HTTP request made by a provider during monitoring passes through this queue. */
export async function monitoredFetch(
  input: string | URL | Request,
  options: RequestInit & { timeoutMs?: number } = {},
) {
  const budget = budgets.getStore();
  const { timeoutMs, ...requestOptions } = options;
  const perform = (target = input, targetOptions = requestOptions) => {
    const signals = [
      targetOptions.signal,
      budget?.signal,
      timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
    ].filter((signal): signal is AbortSignal => !!signal);
    const init: RequestInit & { dispatcher?: Dispatcher } = {
      ...targetOptions,
      signal: signals.length ? AbortSignal.any(signals) : undefined,
    };
    if (budget?.dispatcher) init.dispatcher = budget.dispatcher;
    return fetch(target, init);
  };
  if (!budget) return perform();
  let target = input;
  let targetOptions = {
    ...requestOptions,
    redirect: "manual" as RequestRedirect,
  };
  for (let hop = 0; ; hop++) {
    const response = await runMonitoredRequest(async () => {
      const response = await perform(target, targetOptions);
      try {
        checkMonitoringResponse(
          response.status,
          response.headers.get("retry-after"),
          budget,
          {
            challenge: response.headers.get("cf-mitigated"),
            serverDate: response.headers.get("date"),
          },
        );
        if (await challengeResponse(response, budget.signal)) {
          blockMonitoringRequests(
            retryAfterMs(
              response.headers.get("retry-after"),
              response.headers.get("date"),
            ),
            budget,
          );
          throw new Error("PROVIDER_BLOCKED");
        }
      } catch (error) {
        void response.body?.cancel().catch(() => {});
        throw error;
      }
      return response;
    }, budget);
    if (
      ![301, 302, 303, 307, 308].includes(response.status) ||
      requestOptions.redirect === "manual"
    )
      return response;
    void response.body?.cancel().catch(() => {});
    if (requestOptions.redirect === "error" || hop >= 3)
      throw new Error("PROVIDER_REDIRECT_LIMIT");
    const location = response.headers.get("location");
    if (!location) throw new Error("PROVIDER_INVALID_REDIRECT");
    const current = new URL(
      target instanceof Request ? target.url : String(target),
    );
    const next = new URL(location, current);
    if (
      !["http:", "https:"].includes(next.protocol) ||
      next.username ||
      next.password ||
      (current.protocol === "https:" && next.protocol !== "https:") ||
      current.hostname.replace(/^www\./, "") !==
        next.hostname.replace(/^www\./, "") ||
      (current.port !== next.port &&
        !(
          current.protocol === "http:" &&
          next.protocol === "https:" &&
          !next.port
        ))
    )
      throw new Error("PROVIDER_UNTRUSTED_REDIRECT");
    const retryMs = retryAfterMs(
      response.headers.get("retry-after"),
      response.headers.get("date"),
    );
    if (retryMs > 0) {
      blockMonitoringRequests(retryMs, budget);
      throw new Error("PROVIDER_BLOCKED");
    }
    const method = (
      targetOptions.method ||
      (target instanceof Request ? target.method : "GET")
    ).toUpperCase();
    const toGet =
      method !== "HEAD" &&
      (response.status === 303 ||
        (method === "POST" && [301, 302].includes(response.status)));
    if (!toGet && !["GET", "HEAD"].includes(method))
      throw new Error("PROVIDER_REDIRECT_REPLAY_REFUSED");
    const headers = new Headers(
      targetOptions.headers ||
        (target instanceof Request ? target.headers : undefined),
    );
    if (next.origin !== current.origin) {
      headers.delete("authorization");
      headers.delete("cookie");
      headers.delete("proxy-authorization");
    }
    if (toGet) {
      headers.delete("content-type");
      headers.delete("content-length");
      targetOptions = {
        ...targetOptions,
        method: "GET",
        body: undefined,
        headers,
      };
    } else targetOptions = { ...targetOptions, method, headers };
    target = next;
  }
}
