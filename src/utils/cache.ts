/** Caché en memoria con vencimiento y tamaño acotado (el más antiguo sale primero). */
export class TtlCache<V> {
  private readonly items = new Map<string, { value: V; expires: number }>();

  constructor(private readonly ttlMs: number, private readonly max = 1000) {}

  get(key: string): V | undefined {
    const hit = this.items.get(key);
    if (!hit) return undefined;
    if (hit.expires <= Date.now()) {
      this.items.delete(key);
      return undefined;
    }
    return hit.value;
  }

  set(key: string, value: V): V {
    if (this.ttlMs <= 0) return value;
    if (this.items.size >= this.max) this.items.delete(this.items.keys().next().value as string);
    this.items.set(key, { value, expires: Date.now() + this.ttlMs });
    return value;
  }

  clear(): void {
    this.items.clear();
  }
}
