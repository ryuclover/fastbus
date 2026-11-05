import type { Page } from "playwright-core";

/** Onboarding tips can cover a valid control; dismiss them through their own close action. */
export async function prepareExtensionControls(popup: Page) {
  const tips = popup
    .locator("first-start-tips-start-vpn, first-start-tips-country-select")
    .filter({ visible: true })
    .first();
  await popup.addLocatorHandler(
    tips,
    async (tip) => {
      await tip.locator(".Close").click();
    },
    { times: 2 },
  );
  const accept = popup.getByText("Accept", { exact: true });
  const start = popup.getByRole("button", { name: "Start VPN", exact: true });
  const change = popup.getByText("Change", { exact: true });
  const ready = start.or(change).filter({ visible: true }).first();
  return { accept, start, change, ready };
}
