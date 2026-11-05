/** Recognize interstitials, not an ordinary page that merely embeds a CAPTCHA widget. */
export function isChallengeHtml(html: string) {
  return (
    /<title[^>]*>[^<]*(?:access denied|just a moment|verify you are human|acesso negado|attention required|robot check|verificação de segurança)[^<]*<\/title>/i.test(
      html,
    ) ||
    /Request unsuccessful\. Incapsula incident ID|Please enable JS and disable any ad blocker/i.test(
      html,
    ) ||
    (/\b_cf_chl_opt\b/.test(html) &&
      /\/cdn-cgi\/challenge-platform\//.test(html))
  );
}

/** HTTP dates are relative to the server's clock when supplied, never shorten the minimum pause. */
export function retryAfterMs(
  value: string | null,
  serverDate?: string | null,
  now = Date.now(),
) {
  if (!value) return 0;
  const seconds = /^\d+$/.test(value.trim()) ? Number(value.trim()) : undefined;
  const server = serverDate ? Date.parse(serverDate) : NaN;
  const result =
    seconds === undefined
      ? Date.parse(value) - (Number.isFinite(server) ? server : now)
      : seconds * 1000;
  return Number.isFinite(result)
    ? Math.max(0, Math.min(result, 8640000000000000 - now))
    : 0;
}

/** Adapt to a slow source; an error must never cause the next request to speed up. */
export function adaptiveDelay(previous: number, latency: number, ok: boolean) {
  const target = Math.min(15000, Math.max(4000, latency));
  const next = Math.max(target, (previous + target) / 2);
  return ok ? next : Math.max(previous, next);
}

/** Only inspect a bounded prefix; leave the original response available to its parser. */
export async function challengeResponse(
  response: Response,
  signal?: AbortSignal,
) {
  if (response.headers.get("cf-mitigated") === "challenge") return true;
  const type = response.headers.get("content-type") || "";
  if (/json|image|font|video|audio|octet-stream/i.test(type) || !response.body)
    return false;
  const reader = response.clone().body!.getReader();
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let prefix = "",
    remaining = 32768;
  try {
    signal?.throwIfAborted();
    while (remaining > 0) {
      const chunk = await reader.read();
      signal?.throwIfAborted();
      if (chunk.done) break;
      const part = chunk.value.subarray(0, remaining);
      remaining -= part.byteLength;
      prefix += decoder.decode(part, { stream: true });
      if (isChallengeHtml(prefix)) return true;
    }
    return isChallengeHtml(prefix + decoder.decode());
  } finally {
    signal?.removeEventListener("abort", cancel);
    // Do not await cancellation of a tee branch: it can wait for the parser's branch.
    cancel();
  }
}
