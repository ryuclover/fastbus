import type { Client } from "whatsapp-web.js";
type InjectionPage = {
  waitForFunction(
    expression: string,
    options: { timeout: number },
  ): Promise<unknown>;
  isClosed(): boolean;
};
export function isNavigationError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated/i.test(
    message,
  );
}
/** WaitTask survives Chromium context changes; a plain page.evaluate polling loop does not. */
export async function injectWhenReady(
  page: InjectionPage,
  inject: () => Promise<void>,
  timeoutMs = 60000,
) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.waitForFunction("window.Debug?.VERSION !== undefined", {
      timeout: Math.max(1, deadline - Date.now()),
    });
    try {
      await inject();
      return;
    } catch (error) {
      if (
        !isNavigationError(error) ||
        page.isClosed() ||
        attempt === 2 ||
        Date.now() >= deadline
      )
        throw error;
    }
  }
}
export function installNavigationRecovery(client: Client) {
  const internal = client as Client & { inject(): Promise<void> };
  const inject = internal.inject.bind(client);
  let pending: Promise<void> | undefined;
  internal.inject = () => {
    if (pending) return pending;
    if (!client.pupPage || client.pupPage.isClosed())
      return Promise.reject(new Error("WhatsApp browser page closed"));
    pending = injectWhenReady(client.pupPage, inject).finally(() => {
      pending = undefined;
    });
    return pending;
  };
}
export function configureWhatsAppNavigation(
  page: NonNullable<Client["pupPage"]>,
) {
  const goto = page.goto.bind(page);
  page.goto = (url, options) =>
    goto(
      url,
      new URL(url).origin === "https://web.whatsapp.com"
        ? { ...options, waitUntil: "domcontentloaded", timeout: 60000 }
        : options,
    );
}
