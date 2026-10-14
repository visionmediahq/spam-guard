// In-memory sliding-window rate limiter for the spam guard.
//
// One container per site, so process memory is enough. `wait()` only looks and
// `record()` only counts, so the guard can count a post after it has passed
// verification. The number of keys is capped: under a flood of unique keys the
// oldest entries are dropped, so memory stays bounded.

export class RateLimiter {
  private readonly hits = new Map<string, number[]>() // insertion-ordered: oldest first

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000
  ) {}

  /** Number of tracked keys. */
  get size(): number {
    return this.hits.size
  }

  /** 0 when allowed, otherwise whole seconds (≥ 1) until the next allowed hit. Never counts. */
  wait(key: string): number {
    const now = Date.now()
    const recent = this.recent(key, now)
    if (recent.length < this.max) return 0
    const oldest = recent[0] ?? now
    return Math.max(1, Math.ceil((this.windowMs - (now - oldest)) / 1000))
  }

  /** Count one hit for the key. */
  record(key: string): void {
    const now = Date.now()
    if (this.hits.size >= this.maxKeys && !this.hits.has(key)) {
      this.pruneExpired(now)
      for (const oldest of this.hits.keys()) {
        if (this.hits.size < this.maxKeys) break
        this.hits.delete(oldest)
      }
    }
    const recent = this.recent(key, now)
    this.hits.delete(key) // re-insert so the key becomes the most recent
    this.hits.set(key, [...recent, now])
  }

  /** wait() and, when allowed, record() in one step. */
  hit(key: string): number {
    const w = this.wait(key)
    if (w === 0) this.record(key)
    return w
  }

  private recent(key: string, now: number): number[] {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
  }

  private pruneExpired(now: number): void {
    for (const [key, times] of this.hits) {
      if (!times.some((t) => now - t < this.windowMs)) this.hits.delete(key)
    }
  }
}

/** Form posts per client: 5 per 10 minutes, counted only after verification. */
export const submitLimiter = new RateLimiter(5, 10 * 60_000)
/** ALTCHA challenges (and client failure reports) per client. */
export const challengeLimiter = new RateLimiter(20, 10 * 60_000)
/** ALTCHA challenges for the whole site — caps the server's PBKDF2 work. */
export const challengeGlobal = new RateLimiter(600, 10 * 60_000)
