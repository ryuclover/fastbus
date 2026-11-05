/** Public free locations documented by Browsec. Selection is stable throughout a worker session. */
const locations = [
  { code: "US", label: "United States" },
  { code: "NL", label: "Netherlands" },
  { code: "GB", label: "United Kingdom" },
  { code: "SG", label: "Singapore" },
] as const;
export function freeBrowserEgress(
  now = Date.now(),
  rotate = process.env.CLICKBUS_FREE_VPN_ROTATION === "1",
) {
  return locations[
    rotate ? Math.floor(now / (6 * 3600000)) % locations.length : 0
  ];
}
