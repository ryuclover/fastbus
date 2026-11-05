import { ProxyAgent } from "undici";

export function parseProxyUrls(raw = ""): string[] {
  if (!raw.trim()) return [];
  try {
    const list: unknown = JSON.parse(raw);
    if (!Array.isArray(list) || list.length < 1 || list.length > 10)
      throw new Error();
    return list.map((value) => {
      if (typeof value !== "string") throw new Error();
      const url = new URL(value);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        !url.hostname ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error();
      // Validate encoding now; never include the input or credentials in errors.
      decodeURIComponent(url.username);
      decodeURIComponent(url.password);
      return url.toString();
    });
  } catch {
    throw new Error(
      "FASTBUS_PROVIDER_PROXY_URLS inválido: use uma lista JSON de até 10 proxies HTTP/HTTPS.",
    );
  }
}

export class ProviderProxyPool {
  private cursor = 0;
  private agents: ProxyAgent[];
  constructor(urls: string[]) {
    this.agents = urls.map((value) => {
      const url = new URL(value);
      const token =
        url.username || url.password
          ? `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`
          : undefined;
      url.username = "";
      url.password = "";
      return new ProxyAgent({ uri: url.toString(), token });
    });
  }
  /** One exit for the whole query; never change IP to retry a denied request. */
  next() {
    if (!this.agents.length) return undefined;
    return this.agents[this.cursor++ % this.agents.length];
  }
  async close() {
    await Promise.all(this.agents.map((agent) => agent.destroy()));
  }
  get size() {
    return this.agents.length;
  }
}

let pool: ProviderProxyPool | undefined;
export function providerProxyPool() {
  return (pool ??= new ProviderProxyPool(
    parseProxyUrls(process.env.FASTBUS_PROVIDER_PROXY_URLS),
  ));
}
export async function closeProviderProxies() {
  await pool?.close();
  pool = undefined;
}
