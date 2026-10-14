import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { TEST_SECRET, solvePayload } from './spam-test-utils'

type Guard = typeof import('../src/lib/spam-guard')
type Altcha = typeof import('../src/lib/spam-altcha')

const ALTCHA_ENV = { SPAM_PROVIDER: 'altcha', ALTCHA_HMAC_SECRET: TEST_SECRET }
const RECAPTCHA_ENV = {
  SPAM_PROVIDER: '',
  RECAPTCHA_SECRET_KEY: 'sec',
  PUBLIC_RECAPTCHA_SITE_KEY: 'site',
  SITE_URL: 'https://kund.example',
}
const ALL_KEYS = ['SPAM_PROVIDER', 'ALTCHA_HMAC_SECRET', 'RECAPTCHA_SECRET_KEY', 'PUBLIC_RECAPTCHA_SITE_KEY', 'SITE_URL', 'RECAPTCHA_ALLOWED_HOSTS']

let warn: ReturnType<typeof vi.spyOn>
let error: ReturnType<typeof vi.spyOn>

/** Fresh modules (fresh limiters, caches), production behaviour unless dev is true. */
async function load(env: Record<string, string>, dev = false): Promise<{ g: Guard; a: Altcha }> {
  vi.stubEnv('DEV', dev)
  for (const k of ALL_KEYS) vi.stubEnv(k, '')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.resetModules()
  const g = await import('../src/lib/spam-guard')
  const a = await import('../src/lib/spam-altcha')
  a._configureForTests({ cost: 10, counterMin: 1, counterMax: 20 })
  return { g, a }
}

function req(xff?: string, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost/api/contact', {
    method: 'POST',
    headers: { ...(xff === undefined ? {} : { 'x-forwarded-for': xff }), ...headers },
  })
}

async function payload(a: Altcha): Promise<string> {
  return solvePayload(await a.createAltchaChallenge())
}

function logLines(): string[] {
  return [...warn.mock.calls, ...error.mock.calls].map((c: unknown[]) => c.map(String).join(' '))
}

function google(body: object): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify(body)))
}
const GOOGLE_OK = { success: true, score: 0.9, action: 'contact', hostname: 'kund.example' }

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('configuration', () => {
  test('unset SPAM_PROVIDER means recaptcha', async () => {
    const { g } = await load(RECAPTCHA_ENV)
    expect(g.provider()).toBe('recaptcha')
    expect(await g.missingConfig()).toBeNull()
  })

  test('an unknown provider is misconfigured in production', async () => {
    const { g } = await load({ SPAM_PROVIDER: 'hcaptcha' })
    expect(g.provider()).toBeNull()
    expect((await g.checkSubmission({}, req('1.2.3.4'))).reason).toBe('misconfigured')
    expect(logLines().some((l) => l.includes('SPAM_PROVIDER'))).toBe(true)
  })

  test('altcha without a secret is misconfigured in production', async () => {
    const { g } = await load({ SPAM_PROVIDER: 'altcha' })
    expect((await g.checkSubmission({}, req('1.2.3.4'))).reason).toBe('misconfigured')
  })

  test('altcha without a request is misconfigured in production', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    expect((await g.checkSubmission({ altcha: await payload(a) })).reason).toBe('misconfigured')
    expect(logLines().some((l) => l.includes('request not passed'))).toBe(true)
  })

  test('dev without a secret lets the post through on the honeypot alone', async () => {
    const { g } = await load({ SPAM_PROVIDER: 'altcha' }, true)
    expect((await g.checkSubmission({}, req('1.2.3.4'))).reason).toBe('ok')
    expect(logLines().some((l) => l.includes('only the honeypot is active (dev only)'))).toBe(true)
  })
})

describe('honeypot', () => {
  test('a filled honeypot is caught and logged with the token diagnostic', async () => {
    const { g } = await load(ALTCHA_ENV)
    expect((await g.checkSubmission({ hp_x7q2: 'x' }, req('1.2.3.4'))).reason).toBe('honeypot')
    expect(logLines()).toContain('[spam-guard] honeypot token=no')
  })

  test('token=yes when an altcha payload came along', async () => {
    const { g } = await load(ALTCHA_ENV)
    await g.checkSubmission({ hp_x7q2: 'x', altcha: 'abc' }, req('1.2.3.4'))
    expect(logLines()).toContain('[spam-guard] honeypot token=yes')
  })

  test('null fields do not throw', async () => {
    const { g } = await load(ALTCHA_ENV)
    expect((await g.checkSubmission(null, req('1.2.3.4'))).reason).toBe('failed')
  })
})

describe('rate limit', () => {
  test('the sixth verified post in ten minutes is limited', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    for (let i = 0; i < 5; i++) {
      expect((await g.checkSubmission({ altcha: await payload(a) }, req('1.2.3.4'))).reason).toBe('ok')
    }
    const c = await g.checkSubmission({ altcha: await payload(a) }, req('1.2.3.4'))
    expect(c.reason).toBe('rate-limited')
    expect(c.retryAfterS).toBeGreaterThan(0)
    expect(logLines().some((l) => /^\[spam-guard\] rejected reason=rate-limited ip=h:[0-9a-f]{6}$/.test(l))).toBe(true)
  })

  test('concurrent verified posts cannot exceed the limit', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    const payloads = await Promise.all(Array.from({ length: 8 }, () => payload(a)))
    const results = await Promise.all(payloads.map((p) => g.checkSubmission({ altcha: p }, req('1.2.3.4'))))
    expect(results.filter((c) => c.reason === 'ok')).toHaveLength(5)
    expect(results.filter((c) => c.reason === 'rate-limited')).toHaveLength(3)
  })

  test('failed posts do not count', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    for (let i = 0; i < 10; i++) {
      expect((await g.checkSubmission({ altcha: 'junk' }, req('1.2.3.4'))).reason).toBe('failed')
    }
    expect((await g.checkSubmission({ altcha: await payload(a) }, req('1.2.3.4'))).reason).toBe('ok')
  })

  test('a 2-argument reCAPTCHA call is never rate-limited', async () => {
    const { g } = await load(RECAPTCHA_ENV)
    google(GOOGLE_OK)
    for (let i = 0; i < 8; i++) {
      expect((await g.checkSubmission({ recaptcha_token: 't' })).reason).toBe('ok')
    }
  })
})

describe('provider verdicts and logging', () => {
  test('an invalid altcha payload fails with one log line', async () => {
    const { g } = await load(ALTCHA_ENV)
    expect((await g.checkSubmission({ altcha: 'junk' }, req('1.2.3.4'))).reason).toBe('failed')
    expect(logLines()).toEqual(['[spam-guard] rejected reason=failed provider=altcha detail=unparseable'])
  })

  test('a reCAPTCHA rejection is logged exactly once', async () => {
    const { g } = await load(RECAPTCHA_ENV)
    google({ ...GOOGLE_OK, score: 0.1 })
    expect((await g.checkSubmission({ recaptcha_token: 't' })).reason).toBe('failed')
    expect(logLines()).toEqual(['[spam-guard] rejected reason=failed provider=recaptcha detail=score'])
  })

  test('accepted altcha posts are logged with their age', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    await g.checkSubmission({ altcha: await payload(a) }, req('1.2.3.4'))
    expect(logLines()).toEqual(['[spam-guard] accepted provider=altcha age_s=0'])
  })

  test('accepted reCAPTCHA posts without a flag are not logged', async () => {
    const { g } = await load(RECAPTCHA_ENV)
    google(GOOGLE_OK)
    expect((await g.checkSubmission({ recaptcha_token: 't' }, req('1.2.3.4'))).reason).toBe('ok')
    expect(logLines()).toEqual([])
  })

  test('a flagged reCAPTCHA post is logged with its flag', async () => {
    const { g } = await load(RECAPTCHA_ENV)
    google(GOOGLE_OK)
    const c = await g.checkSubmission(
      { recaptcha_token: 't', message: 'https://a.example https://b.example https://c.example' },
      req('1.2.3.4')
    )
    expect(c).toEqual({ reason: 'ok', flag: 'links' })
    expect(logLines()).toEqual(['[spam-guard] accepted provider=recaptcha flag=links'])
  })

  test('messageFields is honoured; no request means no content flag', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    const cyr = 'Здравствуйте, предлагаем услуги продвижения сайта в поисковых системах'
    const c = await g.checkSubmission({ altcha: await payload(a), meddelande: cyr }, req('1.2.3.4'), {
      messageFields: ['meddelande'],
    })
    expect(c.flag).toBe('script')
    const r = await load(RECAPTCHA_ENV)
    google(GOOGLE_OK)
    expect((await r.g.checkSubmission({ recaptcha_token: 't', message: 'https://a.example https://b.example https://c.example' })).flag).toBeUndefined()
  })

  test('logs never contain the message, e-mail or raw IP', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    const fields = { message: 'hemligt meddelande', email: 'anna@kund.example', altcha: await payload(a) }
    await g.checkSubmission(fields, req('9.8.7.6'))
    await g.checkSubmission({ ...fields, altcha: 'junk' }, req('9.8.7.6'))
    for (let i = 0; i < 6; i++) await g.checkSubmission({ ...fields, altcha: await payload(a) }, req('9.8.7.6'))
    const all = logLines().join('\n')
    expect(all).not.toContain('hemligt')
    expect(all).not.toContain('anna@kund.example')
    expect(all).not.toContain('9.8.7.6')
  })
})

describe('clientIp and ipKey', () => {
  test('uses the last X-Forwarded-For hop', async () => {
    const { g } = await load(ALTCHA_ENV)
    expect(g.clientIp(req('9.9.9.9, 1.2.3.4'))).toBe('1.2.3.4')
  })

  test('trusts CF-Connecting-IP only from a Cloudflare peer', async () => {
    const { g } = await load(ALTCHA_ENV)
    expect(g.clientIp(req('5.6.7.8, 173.245.48.1', { 'cf-connecting-ip': '5.6.7.8' }))).toBe('5.6.7.8')
    expect(g.clientIp(req('2606:4700::1', { 'cf-connecting-ip': '2001:db8::5' }))).toBe('2001:db8::5')
    expect(g.clientIp(req('1.2.3.4', { 'cf-connecting-ip': '5.6.7.8' }))).toBe('1.2.3.4')
  })

  test('a cf-ray header from a non-Cloudflare peer warns once', async () => {
    const { g } = await load(ALTCHA_ENV)
    g.clientIp(req('1.2.3.4', { 'cf-ray': 'abc' }))
    g.clientIp(req('1.2.3.4', { 'cf-ray': 'abc' }))
    expect(logLines().filter((l) => l.includes('ranges may be stale'))).toHaveLength(1)
  })

  test('no X-Forwarded-For gives unknown and warns once', async () => {
    const { g } = await load(ALTCHA_ENV)
    expect(g.clientIp(req())).toBe('unknown')
    expect(g.clientIp(req())).toBe('unknown')
    expect(logLines().filter((l) => l.includes('X-Forwarded-For missing'))).toHaveLength(1)
  })

  test('IPv6 addresses in one /64 share a key', async () => {
    const { g } = await load(ALTCHA_ENV)
    expect(g.ipKey('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64')
    expect(g.ipKey('2001:db8:1:2:ffff::1')).toBe('2001:db8:1:2::/64')
    expect(g.ipKey('2001:db8::1')).toBe('2001:db8:0:0::/64')
    expect(g.ipKey('1.2.3.4')).toBe('1.2.3.4')
  })

  test('odd X-Forwarded-For values never throw (Review Focus 4)', async () => {
    const { g } = await load(ALTCHA_ENV)
    expect(g.clientIp(req(''))).toBe('unknown')
    expect(g.clientIp(req(' , '))).toBe('unknown')
    expect(g.clientIp(req('::ffff:1.2.3.4'))).toBe('1.2.3.4')
    expect(g.clientIp(req('garbage'))).toBe('garbage')
    expect(() => g.ipKey(g.clientIp(req('fe80::1%eth0')))).not.toThrow()
    expect(() => g.ipKey('garbage')).not.toThrow()
    const { a } = await load(ALTCHA_ENV)
    const fresh = await import('../src/lib/spam-guard')
    expect((await fresh.checkSubmission({ altcha: await payload(a) }, req('garbage, , fe80::1%eth0'))).reason).toBe('ok')
  })
})

describe('ipHash', () => {
  test('stable within a UTC day, different the next day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-04T10:00:00Z'))
    const { g } = await load(ALTCHA_ENV)
    const h1 = g.ipHash('1.2.3.4')
    expect(h1).toMatch(/^h:[0-9a-f]{6}$/)
    expect(g.ipHash('1.2.3.4')).toBe(h1)
    vi.setSystemTime(new Date('2026-10-05T00:00:01Z'))
    expect(g.ipHash('1.2.3.4')).not.toBe(h1)
  })
})

describe('checkResponse and guardSubmission', () => {
  test('maps each reason to a response', async () => {
    const { g } = await load(ALTCHA_ENV)
    expect(g.checkResponse({ reason: 'ok' })).toBeNull()
    const hp = g.checkResponse({ reason: 'honeypot' })!
    expect([hp.status, await hp.json()]).toEqual([200, { success: true }])
    const rl = g.checkResponse({ reason: 'rate-limited', retryAfterS: 42 })!
    expect([rl.status, rl.headers.get('Retry-After'), (await rl.json()).error]).toEqual([429, '42', g.RATE_LIMITED_TEXT])
    const f = g.checkResponse({ reason: 'failed' })!
    expect([f.status, (await f.json()).error]).toEqual([400, 'Verifiering misslyckades. Försök igen.'])
    const m = g.checkResponse({ reason: 'misconfigured' })!
    expect([m.status, (await m.json()).error]).toEqual([503, g.UNAVAILABLE_TEXT])
  })

  test('declares UTF-8 so a raw no-JS reply renders å/ä/ö', async () => {
    const { g } = await load(ALTCHA_ENV)
    const f = g.checkResponse({ reason: 'failed' })!
    expect(f.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
  })

  test('a 2-argument call with a good reCAPTCHA token continues (regression)', async () => {
    const { g } = await load(RECAPTCHA_ENV)
    google(GOOGLE_OK)
    expect(await g.guardSubmission({ recaptcha_token: 't' }, 'contact')).toBeNull()
  })

  test('a 2-argument call with a bad token is rejected (regression)', async () => {
    const { g } = await load(RECAPTCHA_ENV)
    google({ ...GOOGLE_OK, hostname: 'evil.example' })
    expect((await g.guardSubmission({ recaptcha_token: 't' }, 'contact'))!.status).toBe(400)
  })

  test('recaptchaSiteKey is still exported from spam-guard', async () => {
    const { g } = await load(RECAPTCHA_ENV)
    expect(g.recaptchaSiteKey()).toBe('site')
  })
})
