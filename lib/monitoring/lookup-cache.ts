/** Only stable lookup metadata belongs here: never prices, seat quotas, tokens or contacts. */
export class LookupCache<T> {
  private values = new Map<string, { value: T; expires: number }>();
  constructor(
    private readonly capacity = 128,
    private readonly ttlMs = 6 * 3600000,
  ) {}
  get(key: string): T | undefined {
    const found = this.values.get(key);
    if (!found) return undefined;
    this.values.delete(key);
    if (found.expires <= Date.now()) return undefined;
    this.values.set(key, found);
    return found.value;
  }
  has(key: string) {
    return this.get(key) !== undefined;
  }
  set(key: string, value: T) {
    this.values.delete(key);
    this.values.set(key, { value, expires: Date.now() + this.ttlMs });
    while (this.values.size > this.capacity)
      this.values.delete(this.values.keys().next().value!);
  }
}
