import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { RateLimiter } from '../src/lib/spam-ratelimit'

const TEN_MIN = 10 * 60_000

describe('RateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  test('allows max hits, then returns whole seconds until the oldest expires', () => {
    const l = new RateLimiter(5, TEN_MIN)
    for (let i = 0; i < 5; i++) l.record('a')
    expect(l.wait('a')).toBe(600)
    vi.setSystemTime(599_001)
    expect(l.wait('a')).toBe(1)
    vi.setSystemTime(599_999)
    expect(l.wait('a')).toBe(1)
    vi.setSystemTime(600_000)
    expect(l.wait('a')).toBe(0)
  })

  test('allows hits below the limit', () => {
    const l = new RateLimiter(5, TEN_MIN)
    for (let i = 0; i < 4; i++) l.record('a')
    expect(l.wait('a')).toBe(0)
  })

  test('wait() never counts', () => {
    const l = new RateLimiter(5, TEN_MIN)
    for (let i = 0; i < 100; i++) l.wait('a')
    expect(l.wait('a')).toBe(0)
    expect(l.size).toBe(0)
  })

  test('hit() records only when allowed', () => {
    const l = new RateLimiter(2, 1000)
    expect(l.hit('a')).toBe(0)
    expect(l.hit('a')).toBe(0)
    expect(l.hit('a')).toBeGreaterThan(0)
    expect(l.hit('a')).toBeGreaterThan(0)
    vi.setSystemTime(1000)
    expect(l.hit('a')).toBe(0)
  })

  test('keys are independent', () => {
    const l = new RateLimiter(1, TEN_MIN)
    l.record('a')
    expect(l.wait('a')).toBeGreaterThan(0)
    expect(l.wait('b')).toBe(0)
  })

  test('key cap holds under a flood of unique keys', () => {
    const l = new RateLimiter(5, TEN_MIN, 100)
    for (let i = 0; i < 10_000; i++) l.record(`k${i}`)
    expect(l.size).toBeLessThanOrEqual(100)
    // The most recent key survives.
    expect(l.wait('k9999')).toBe(0)
    l.record('k9999')
    l.record('k9999')
    l.record('k9999')
    l.record('k9999')
    expect(l.wait('k9999')).toBeGreaterThan(0)
  })

  test('expired entries are pruned before the oldest key is evicted', () => {
    const l = new RateLimiter(1, 1000, 3)
    l.record('old1')
    l.record('old2')
    vi.setSystemTime(500)
    l.record('blocked')
    vi.setSystemTime(1200)
    // old1 and old2 have expired; adding a key prunes them instead of evicting 'blocked'.
    l.record('new')
    expect(l.wait('blocked')).toBeGreaterThan(0)
    expect(l.size).toBe(2)
  })
})
