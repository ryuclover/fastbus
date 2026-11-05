import { randomInt } from "node:crypto";

/** Add pauses without shortening the user's interval or a provider's cooldown. */
export function scheduledDelay(minimumMs: number, extraMs: number) {
  return minimumMs + randomInt(extraMs + 1);
}

export const requestSpacing = () => scheduledDelay(4000, 4000);
export const providerSpacing = () => scheduledDelay(5 * 60000, 2 * 60000);
export const monitorSpacing = (minutes: number) =>
  scheduledDelay(minutes * 60000, Math.min(minutes * 6000, 5 * 60000));

/** Provider failures pause for 15 minutes, doubling up to one day. */
export const providerBackoff = (failures: number) =>
  Math.min(1440, 15 * 2 ** Math.min(failures - 1, 7)) * 60000;
