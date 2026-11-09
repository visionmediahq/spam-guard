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
const ALL_KEYS = ['SPAM_PROVIDER', 'ALTCHA_HMAC_SECRET', 'RECAPTCHA_SECRET_KEY', 'PUBLIC_RECAPTCHA_SITE_KEY', 'SITE_URL', 'RECAPTCHA_ALLOWED_HOSTS', 'SPAM_BLOCK']

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

  test('a filled honeypot with a token that fails verification still gets the fake success', async () => {
    const { g } = await load(ALTCHA_ENV)
    expect((await g.checkSubmission({ hp_x7q2: 'x', altcha: 'abc' }, req('1.2.3.4'))).reason).toBe('honeypot')
    expect(logLines()).toContain('[spam-guard] honeypot token=yes')
  })

  test('a filled honeypot with a verified altcha payload is an autofilled human: sent, flagged', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    const c = await g.checkSubmission({ email: 'anna@example.se', hp_x7q2: 'anna@example.se', altcha: await payload(a) }, req('1.2.3.4'))
    expect(c).toEqual({ reason: 'ok', flag: 'honeypot' })
    expect(logLines()).toContain('[spam-guard] honeypot-overridden provider=altcha')
  })

  test('a filled honeypot with a verified reCAPTCHA token is sent, flagged', async () => {
    const { g } = await load(RECAPTCHA_ENV)
    google(GOOGLE_OK)
    const c = await g.checkSubmission({ name: 'Anna Berg', hp_x7q2: 'Anna Berg', recaptcha_token: 'tok' }, req('1.2.3.4'))
    expect(c).toEqual({ reason: 'ok', flag: 'honeypot' })
    expect(logLines()).toContain('[spam-guard] honeypot-overridden provider=recaptcha')
  })

  test('an overridden honeypot post counts toward the rate limit', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    for (let i = 0; i < 5; i++) {
      expect((await g.checkSubmission({ email: 'a@b.se', hp_x7q2: 'a@b.se', altcha: await payload(a) }, req('1.2.3.4'))).reason).toBe('ok')
    }
    expect((await g.checkSubmission({ email: 'a@b.se', hp_x7q2: 'a@b.se', altcha: await payload(a) }, req('1.2.3.4'))).reason).toBe('rate-limited')
  })

  test('autofill is recognised across case, spacing and phone formatting', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    const cases: Record<string, string>[] = [
      { email: 'Anna@Example.se', hp_x7q2: ' anna@example.se ' },
      { phone: '070-123 45 67', hp_x7q2: '0701234567' },
      { name: 'Anna Berg', hp_x7q2: 'Anna' }, // first name only
      { phone: '070-123 45 67', hp_x7q2: '+46 70 123 45 67' }, // stored with the country code
      { phone: '070.123.45.67', hp_x7q2: '070-123 45 67' },
      { name: '\u00c5sa Str\u00f6m', hp_x7q2: 'A\u030asa Stro\u0308m' }, // composed vs decomposed å ö
      { phone: '031-12 34 56', hp_x7q2: '+46 31 12 34 56' }, // short landline
      { phone: '08-12 34 56', hp_x7q2: '+46 8 12 34 56' },
      { phone: '+46 40 12 34 56', hp_x7q2: '040-12 34 56' },
      { phone: '08-123 45 67', hp_x7q2: '0046 8 123 45 67' },
      { phone: '+46 (0)8 123 45 67', hp_x7q2: '08-123 45 67' },
      { phone: '070-123 45 67 (mobil)', hp_x7q2: '+46701234567' }, // text around the number
      { address: 'Storgatan 12, 831 30 Östersund', hp_x7q2: 'Storgatan 12' }, // part of a longer value
      { name: 'Anna S.', hp_x7q2: 'Anna Svensson' }, // initials
      { name: 'A. Svensson', hp_x7q2: 'A Svensson' },
      { name: 'Anna M. Svensson', hp_x7q2: 'Anna Svensson' },
      { phone: '070-123 45 67 / 08-123 45 67', hp_x7q2: '+46 70 123 45 67' }, // two numbers in one field
      { phone: '070 123 45 67 08 123 45 67', hp_x7q2: '+46 8 123 45 67' },
      { fornamn: 'Bo', efternamn: 'Ek', hp_x7q2: 'Bo Ek' }, // split name fields, two-letter names
      { name: 'Anna-Karin Maria Louise af Ugglas', hp_x7q2: 'Anna-Karin' }, // a 5-word name
    ]
    for (const [i, fields] of cases.entries()) {
      const c = await g.checkSubmission({ ...fields, altcha: await payload(a) }, req(`1.2.3.${i + 1}`))
      expect(c, JSON.stringify(fields)).toEqual({ reason: 'ok', flag: 'honeypot' })
    }
  })

  test('a verified post whose honeypot matches no other field is a bot: fake success, dropped', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    const fields = {
      name: 'hwcxfAXYrTLOWycHCCtig',
      email: 'el.iyam.a21.9@gmail.com',
      company: 'Oxthdmb LLC',
      phone: '9662222542',
      message: 'QoZpsQqfeJvfKOuDah',
      hp_x7q2: 'KzPqWvBnTrLmYxCd',
      altcha: await payload(a),
    }
    expect(await g.checkSubmission(fields, req('1.2.3.4'))).toEqual({ reason: 'honeypot' })
    expect(logLines()).toContain('[spam-guard] honeypot token=yes match=no kind=token len=16 provider=altcha')
    expect(logLines().some((l) => l.includes('honeypot-overridden'))).toBe(false)
  })

  test('JSON numbers and arrays count as fields to match', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    const cases: Record<string, unknown>[] = [
      { phone: 701234567, hp_x7q2: '070 123 45 67' },
      { emails: ['x@y.se', 'anna@example.se'], hp_x7q2: 'anna@example.se' },
      { contact: { name: 'Anna Berg', email: 'anna@example.se' }, hp_x7q2: 'anna@example.se' }, // nested
    ]
    for (const fields of cases) {
      const c = await g.checkSubmission({ ...fields, altcha: await payload(a) }, req('1.2.3.4'))
      expect(c, JSON.stringify(fields)).toEqual({ reason: 'ok', flag: 'honeypot' })
    }
  })

  test('a name listed in messageFields still counts as a match', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    const fields = { namn: 'Anna Berg', meddelande: 'Hej!', hp_x7q2: 'Anna Berg', altcha: await payload(a) }
    const c = await g.checkSubmission(fields, req('1.2.3.4'), { messageFields: ['namn', 'meddelande'] })
    expect(c).toEqual({ reason: 'ok', flag: 'honeypot' })
  })

  test('a short honeypot does not match by being part of a long message', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    const message = 'Hej, det gäller en offert på tre maskiner till vårt lager i Östersund, gärna snart.'
    const fields = { name: 'Anna Berg', message, hp_x7q2: 'det', altcha: await payload(a) }
    expect(await g.checkSubmission(fields, req('1.2.3.4'))).toEqual({ reason: 'honeypot' })
  })

  test('a dropped honeypot logs the shape of its value, never the value', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    const shapes: [string, string][] = [
      ['KzPqWvBnTrLmYxCd', 'kind=token len=16'],
      ['someone@example.se', 'kind=email len=18'],
      ['+46 8 99 99 99', 'kind=phone len=14'],
      ['Nils Holm', 'kind=words len=9'],
    ]
    for (const [i, [hp, shape]] of shapes.entries()) {
      await g.checkSubmission({ name: 'Anna Berg', hp_x7q2: hp, altcha: await payload(a) }, req(`1.2.4.${i + 1}`))
      expect(logLines()).toContain(`[spam-guard] honeypot token=yes match=no ${shape} provider=altcha`)
    }
    expect(logLines().join('\n')).not.toMatch(/KzPq|someone|Nils/)
  })

  test('a dropped solving bot still counts toward the rate limit', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    for (let i = 0; i < 5; i++) {
      expect((await g.checkSubmission({ hp_x7q2: 'KzPqWvBnTr', altcha: await payload(a) }, req('1.2.3.4'))).reason).toBe('honeypot')
    }
    expect((await g.checkSubmission({ name: 'Anna', altcha: await payload(a) }, req('1.2.3.4'))).reason).toBe('rate-limited')
  })

  test('split two-letter names count only as a whole: one short word is not enough', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    const c = await g.checkSubmission({ fornamn: 'Bo', efternamn: 'Ek', hp_x7q2: 'Bo Xq', altcha: await payload(a) }, req('1.2.3.4'))
    expect(c).toEqual({ reason: 'honeypot' })
  })

  test('a honeypot needs 3 letters or digits: punctuation alone never counts', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    const c = await g.checkSubmission({ name: 'Hm...', hp_x7q2: '...', altcha: await payload(a) }, req('1.2.3.4'))
    expect(c).toEqual({ reason: 'honeypot' })
  })

  test('a honeypot longer than any autofill value is dropped without comparing (no quadratic work)', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    const runs = Array.from({ length: 20000 }, (_, i) => String(1000000 + i)).join('x')
    const started = performance.now()
    const c = await g.checkSubmission({ message: runs, phone: runs, hp_x7q2: runs, altcha: await payload(a) }, req('1.2.3.4'))
    expect(c).toEqual({ reason: 'honeypot' })
    expect(performance.now() - started).toBeLessThan(500)
  })

  test('a one- or two-character honeypot value never counts as autofill', async () => {
    const { g } = await load(RECAPTCHA_ENV)
    google(GOOGLE_OK)
    const c = await g.checkSubmission({ name: 'Anna Berg', hp_x7q2: 'a', recaptcha_token: 'tok' }, req('1.2.3.4'))
    expect(c).toEqual({ reason: 'honeypot' })
  })

  test('a filled honeypot without a token never reaches the provider', async () => {
    const { g } = await load(RECAPTCHA_ENV)
    const fetch = vi.spyOn(globalThis, 'fetch')
    expect((await g.checkSubmission({ hp_x7q2: 'x' }, req('1.2.3.4'))).reason).toBe('honeypot')
    expect(fetch).not.toHaveBeenCalled()
  })

  test('dev without keys still drops a filled honeypot', async () => {
    const { g } = await load({ SPAM_PROVIDER: 'altcha' }, true)
    expect((await g.checkSubmission({ hp_x7q2: 'x', altcha: 'abc' }, req('1.2.3.4'))).reason).toBe('honeypot')
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

describe('sender blocklist', () => {
  const BLOCK = 'email:Spam@Example.se, email:@junk.example; phone:+46700000000\n'
  const blocked = (e: Record<string, string> = {}) => load({ ...ALTCHA_ENV, SPAM_BLOCK: BLOCK, ...e })

  test('an exact address is dropped with the fake success, logged without the value', async () => {
    const { g, a } = await blocked()
    const c = await g.checkSubmission({ name: 'X', email: ' spam@EXAMPLE.se ', message: 'Hej', altcha: await payload(a) }, req('1.2.3.4'))
    expect(c).toEqual({ reason: 'honeypot' })
    expect(logLines()).toContain('[spam-guard] blocked kind=email provider=altcha')
    expect(logLines().join('\n')).not.toMatch(/spam@example|junk\.example|700000000/i)
  })

  test('@domain matches the domain and its subdomains, not a longer name ending the same way', async () => {
    const { g, a } = await blocked()
    for (const email of ['a@junk.example', 'b@mail.junk.example']) {
      expect((await g.checkSubmission({ email, altcha: await payload(a) }, req('1.2.3.4'))).reason).toBe('honeypot')
    }
    expect(logLines()).toContain('[spam-guard] blocked kind=domain provider=altcha')
    expect((await g.checkSubmission({ email: 'c@notjunk.example', altcha: await payload(a) }, req('1.2.3.5'))).reason).toBe('ok')
  })

  test('a phone number matches in any national or international form', async () => {
    const { g, a } = await blocked()
    for (const [i, phone] of ['070-000 00 00', '0046 70 000 00 00', '+46 (0)70 000 00 00', '0700000000 / 0701112233', '0701112233 0700000000',
      '070–000 00 00', '070−000 00 00', '070-111 22 33, 070-000 00 00', '08-765 43 21; 0700000000'].entries()) {
      expect((await g.checkSubmission({ phone, altcha: await payload(a) }, req(`10.0.0.${i}`))).reason).toBe('honeypot') // own IP each: 9 posts
    }
    expect(logLines()).toContain('[spam-guard] blocked kind=phone provider=altcha')
  })

  test('another area code or a longer number is someone else', async () => {
    const { g, a } = await blocked({ SPAM_BLOCK: 'phone:08-123 45 67, phone:031-12 34 56' })
    for (const phone of ['018-123 45 67', '070-812 34 567', '123 45 67', '0731-12 34 56', '+1 812 345 67']) {
      expect((await g.checkSubmission({ phone, altcha: await payload(a) }, req('1.2.3.4'))).reason).toBe('ok')
    }
  })

  test('an area code written with a slash stays part of the number', async () => {
    const { g, a } = await blocked({ SPAM_BLOCK: 'phone:123 45 67' })
    expect((await g.checkSubmission({ phone: '08/123 45 67', altcha: await payload(a) }, req('1.2.3.4'))).reason).toBe('ok')
  })

  test('a foreign number matches in + and 00 form', async () => {
    const { g, a } = await blocked({ SPAM_BLOCK: 'phone:+1 (555) 010-0199' })
    for (const phone of ['+15550100199', '001 555 010 0199']) {
      expect((await g.checkSubmission({ phone, altcha: await payload(a) }, req('1.2.3.4'))).reason).toBe('honeypot')
    }
    expect((await g.checkSubmission({ phone: '555 010 0199', altcha: await payload(a) }, req('1.2.3.5'))).reason).toBe('ok')
  })

  test('trailing punctuation after an address does not hide it', async () => {
    const { g, a } = await blocked()
    for (const email of ['spam@example.se.', 'x@junk.example!']) {
      expect((await g.checkSubmission({ email, altcha: await payload(a) }, req('1.2.3.4'))).reason).toBe('honeypot')
    }
  })

  test('a blocked sender is dropped even when the honeypot looks autofilled', async () => {
    const { g, a } = await blocked()
    const c = await g.checkSubmission({ email: 'spam@example.se', hp_x7q2: 'spam@example.se', altcha: await payload(a) }, req('1.2.3.4'))
    expect(c).toEqual({ reason: 'honeypot' })
    expect(logLines()).toContain('[spam-guard] blocked kind=email provider=altcha')
  })

  test('any field whose value is an address or number counts, nested JSON and arrays too', async () => {
    const { g, a } = await blocked()
    expect((await g.checkSubmission({ contact: { mail: 'spam@example.se' }, altcha: await payload(a) }, req('1.2.3.4'))).reason).toBe('honeypot')
    expect((await g.checkSubmission({ tel: ['070-000 00 00'], altcha: await payload(a) }, req('1.2.3.4'))).reason).toBe('honeypot')
  })

  test('an address or number inside free text is not looked at, whatever the field is called', async () => {
    const { g, a } = await blocked()
    const posts = [
      { email: 'anna@kund.se', message: 'Vi fick spam från spam@example.se', altcha: '' },
      { email: 'anna@kund.se', subject: 'Fråga om spam@example.se', altcha: '' },
      { email: 'anna@kund.se', ovrigt: 'ring 070-000 00 00 efter 5', altcha: '' },
    ]
    for (const p of posts) {
      p.altcha = await payload(a)
      expect((await g.checkSubmission(p, req('1.2.3.6'))).reason).toBe('ok')
    }
  })

  test('entries passed in code add to SPAM_BLOCK', async () => {
    const { g, a } = await blocked()
    const opts = { block: ['email:other@x.se'] }
    expect((await g.checkSubmission({ email: 'other@x.se', altcha: await payload(a) }, req('1.2.3.4'), opts)).reason).toBe('honeypot')
    expect((await g.checkSubmission({ email: 'spam@example.se', altcha: await payload(a) }, req('1.2.3.4'), opts)).reason).toBe('honeypot')
  })

  test('code entries work without SPAM_BLOCK, and an empty list blocks nothing', async () => {
    const { g, a } = await load(ALTCHA_ENV)
    expect((await g.checkSubmission({ email: 'spam@example.se', altcha: await payload(a) }, req('1.2.3.4'))).reason).toBe('ok')
    const c = await g.checkSubmission({ email: 'spam@example.se', altcha: await payload(a) }, req('1.2.3.4'), { block: ['email:spam@example.se'] })
    expect(c.reason).toBe('honeypot')
  })

  test('a bad entry is skipped with one warning naming its position, and the rest still apply', async () => {
    const { g, a } = await blocked({ SPAM_BLOCK: 'name:Bob, email:, phone:123, email:spam@example.se' })
    for (let i = 0; i < 2; i++) {
      expect((await g.checkSubmission({ email: 'spam@example.se', altcha: await payload(a) }, req('1.2.3.4'))).reason).toBe('honeypot')
    }
    const warnings = logLines().filter((l) => l.includes('SPAM_BLOCK'))
    expect(warnings).toEqual(['[spam-guard] SPAM_BLOCK: skipped entries 1, 2, 3 (use email:address, email:@domain or phone:number)'])
    expect(warnings.join()).not.toContain('Bob')
  })

  test('a blocked post counts toward the rate limit', async () => {
    const { g, a } = await blocked()
    for (let i = 0; i < 5; i++) {
      expect((await g.checkSubmission({ email: 'spam@example.se', altcha: await payload(a) }, req('1.2.3.4'))).reason).toBe('honeypot')
    }
    expect((await g.checkSubmission({ email: 'anna@kund.se', altcha: await payload(a) }, req('1.2.3.4'))).reason).toBe('rate-limited')
  })

  test('the provider still runs first: an unverified post from a blocked sender fails as usual', async () => {
    const { g } = await blocked()
    expect((await g.checkSubmission({ email: 'spam@example.se', altcha: 'junk' }, req('1.2.3.4'))).reason).toBe('failed')
    expect(logLines().some((l) => l.includes('blocked'))).toBe(false)
  })

  test('reCAPTCHA sites are covered too', async () => {
    const { g } = await load({ ...RECAPTCHA_ENV, SPAM_BLOCK: BLOCK })
    google(GOOGLE_OK)
    expect((await g.checkSubmission({ email: 'spam@example.se', recaptcha_token: 't' }, req('1.2.3.4'))).reason).toBe('honeypot')
    expect(logLines()).toContain('[spam-guard] blocked kind=email provider=recaptcha')
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
