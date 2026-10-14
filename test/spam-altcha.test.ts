import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { TEST_SECRET, solvePayload } from './spam-test-utils'

type Mod = typeof import('./spam-altcha')

async function load(secret: string | undefined = TEST_SECRET): Promise<Mod> {
  vi.stubEnv('ALTCHA_HMAC_SECRET', secret ?? '')
  vi.resetModules()
  const m = await import('./spam-altcha')
  m._configureForTests({ cost: 10, counterMin: 1, counterMax: 20 })
  return m
}

async function freshPayload(m: Mod): Promise<string> {
  return solvePayload(await m.createAltchaChallenge())
}

function decode(raw: string): any {
  return JSON.parse(atob(raw))
}
function encode(value: unknown): string {
  return btoa(JSON.stringify(value))
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-04T10:00:00Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('altchaConfigured', () => {
  test('false without a secret', async () => {
    expect(await (await load('')).altchaConfigured()).toBe(false)
  })
  test('false with a secret shorter than 32 characters', async () => {
    expect(await (await load('x'.repeat(31))).altchaConfigured()).toBe(false)
  })
  test('true with 32 characters', async () => {
    expect(await (await load('x'.repeat(32))).altchaConfigured()).toBe(true)
  })
})

describe('createAltchaChallenge', () => {
  test('expires in 2 hours, carries a signed issue time and a key signature', async () => {
    const m = await load()
    const c = await m.createAltchaChallenge()
    expect(c.parameters.expiresAt).toBe(Math.floor(Date.now() / 1000) + 7200)
    expect(c.parameters.data?.iat).toBe(Date.now())
    expect(typeof c.parameters.keySignature).toBe('string')
    expect(typeof c.signature).toBe('string')
  })

  test('production difficulty is the Gate A value', async () => {
    vi.stubEnv('ALTCHA_HMAC_SECRET', TEST_SECRET)
    vi.resetModules()
    const m = await import('./spam-altcha')
    const c = await m.createAltchaChallenge()
    expect(c.parameters.cost).toBe(5000)
  })
})

describe('verifyAltcha', () => {
  test('accepts a valid payload and reports its age', async () => {
    const m = await load()
    const raw = await freshPayload(m)
    vi.setSystemTime(Date.now() + 47_000)
    expect(await m.verifyAltcha(raw)).toEqual({ status: 'ok', ageS: 47 })
  })

  test('rejects a replayed payload', async () => {
    const m = await load()
    const raw = await freshPayload(m)
    expect((await m.verifyAltcha(raw)).status).toBe('ok')
    expect(await m.verifyAltcha(raw)).toEqual({ status: 'rejected', detail: 'replayed' })
  })

  test('rejects an expired payload', async () => {
    const m = await load()
    const raw = await freshPayload(m)
    vi.setSystemTime(Date.now() + 2 * 3600_000 + 1000)
    expect(await m.verifyAltcha(raw)).toEqual({ status: 'rejected', detail: 'expired' })
  })

  test('rejects an altered signature', async () => {
    const m = await load()
    const p = decode(await freshPayload(m))
    p.challenge.signature = p.challenge.signature.replace(/^./, (c: string) => (c === '0' ? '1' : '0'))
    expect(await m.verifyAltcha(encode(p))).toEqual({ status: 'rejected', detail: 'invalid' })
  })

  test('rejects altered signed parameters', async () => {
    const m = await load()
    const p = decode(await freshPayload(m))
    p.challenge.parameters.expiresAt += 3600
    expect(await m.verifyAltcha(encode(p))).toEqual({ status: 'rejected', detail: 'invalid' })
  })

  test('rejects a payload made with another secret', async () => {
    const other = await load('b'.repeat(64))
    const raw = await freshPayload(other)
    const m = await load()
    expect(await m.verifyAltcha(raw)).toEqual({ status: 'rejected', detail: 'invalid' })
  })

  test('missing value', async () => {
    const m = await load()
    expect(await m.verifyAltcha(undefined)).toEqual({ status: 'rejected', detail: 'missing' })
    expect(await m.verifyAltcha('')).toEqual({ status: 'rejected', detail: 'missing' })
  })

  test('unparseable values', async () => {
    const m = await load()
    for (const raw of ['%%%', btoa('{'), btoa('null'), encode({ challenge: {} }), encode({ solution: {} })]) {
      expect(await m.verifyAltcha(raw)).toEqual({ status: 'rejected', detail: 'unparseable' })
    }
  })

  test('odd-length hex in the solution is rejected, not thrown', async () => {
    const m = await load()
    const p = decode(await freshPayload(m))
    p.solution.derivedKey = 'abc'
    const v = await m.verifyAltcha(encode(p))
    expect(v.status).toBe('rejected')
  })

  test('values that are not one string are rejected, never thrown (Review Focus 3)', async () => {
    const m = await load()
    for (const raw of [['a', 'b'], 42, new File(['x'], 'x'), { a: 1 }, null, true]) {
      expect(await m.verifyAltcha(raw)).toEqual({ status: 'rejected', detail: raw == null ? 'missing' : 'unparseable' })
    }
  })

  test('misconfigured without a secret', async () => {
    const m = await load('')
    expect((await m.verifyAltcha(encode({ challenge: { parameters: { nonce: 'n' }, signature: 's' }, solution: { derivedKey: 'k' } }))).status).toBe('misconfigured')
  })
})

describe('replay store', () => {
  test('when full, a new valid payload is rejected and nothing is evicted', async () => {
    const m = await load()
    m._configureForTests({ maxUsed: 2 })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = await freshPayload(m)
    const b = await freshPayload(m)
    const c = await freshPayload(m)
    expect((await m.verifyAltcha(a)).status).toBe('ok')
    expect((await m.verifyAltcha(b)).status).toBe('ok')
    expect(await m.verifyAltcha(c)).toEqual({ status: 'rejected', detail: 'replay-store-full' })
    expect(error).toHaveBeenCalledTimes(1)
    expect(await m.verifyAltcha(a)).toEqual({ status: 'rejected', detail: 'replayed' })
  })

  test('expired entries are pruned, freeing the store', async () => {
    const m = await load()
    m._configureForTests({ maxUsed: 1 })
    expect((await m.verifyAltcha(await freshPayload(m))).status).toBe('ok')
    vi.setSystemTime(Date.now() + 2 * 3600_000 + 1000)
    expect((await m.verifyAltcha(await freshPayload(m))).status).toBe('ok')
  })
})
