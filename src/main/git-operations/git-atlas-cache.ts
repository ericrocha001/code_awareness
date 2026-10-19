export class AtlasCache {
  private readonly entries = new Map<string, { value: unknown; bytes: number }>()
  private bytes = 0
  constructor(private readonly capacity = 64, private readonly byteLimit = 8 * 1024 * 1024) {}
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key)
    if (!entry) return undefined
    this.entries.delete(key); this.entries.set(key, entry)
    return structuredClone(entry.value) as T
  }
  set(key: string, value: unknown) {
    const bytes = Buffer.byteLength(JSON.stringify(value))
    if (bytes > this.byteLimit) return
    const existing = this.entries.get(key)
    if (existing) { this.bytes -= existing.bytes; this.entries.delete(key) }
    this.entries.set(key, { value: structuredClone(value), bytes }); this.bytes += bytes
    while (this.entries.size > this.capacity || this.bytes > this.byteLimit) {
      const oldest = this.entries.keys().next().value!
      this.bytes -= this.entries.get(oldest)!.bytes; this.entries.delete(oldest)
    }
  }
  clear() { this.entries.clear(); this.bytes = 0 }
}
