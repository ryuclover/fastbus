const zoneFormats = new Map<string, Intl.DateTimeFormat>();
export function localInstant(
  date: string,
  time: string | undefined,
  zone: string | null,
) {
  if (!zone || !time || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) return null;
  const wall = Date.parse(date + "T" + time + ":00Z");
  if (!Number.isFinite(wall)) return null;
  let fmt = zoneFormats.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("sv-SE", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    zoneFormats.set(zone, fmt);
  }
  const candidates = [];
  for (let offset = 2; offset <= 5; offset++) {
    const instant = wall + offset * 3600000;
    if (fmt.format(instant) === date + " " + time) candidates.push(instant);
  }
  return candidates.length === 1 ? candidates[0] : null;
}
