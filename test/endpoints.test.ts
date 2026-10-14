// Endpoint tests live in src/lib: a *.test.ts under src/pages would become a route.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { TEST_SECRET, solvePayload } from './spam-test-utils'

const sent: Array<{ subject: string }> = []
// Set to make the next sends fail the way Resend does: an { error } result, not a throw.
let resendRejects = false
vi.mock('resend', () => ({
  Resend: class {
    emails = {
      send: async (msg: { subject: string }) => {
        if (resendRejects) return { data: null, error: { name: 'validation_error', message: 'domain is not verified' } }
        sent.push(msg)
        return { data: { id: 'x' }, error: null }
      },
    }
  },
}))

const ALTCHA_ENV = {
  SPAM_PROVIDER: 'altcha',
  ALTCHA_HMAC_SECRET: TEST_SECRET,
  RESEND_API_KEY: 're_test',
  CONTACT_TO: 'a@kund.se',
}
const ALL_KEYS = ['SPAM_PROVIDER', 'ALTCHA_HMAC_SECRET', 'RECAPTCHA_SECRET_KEY', 'PUBLIC_RECAPTCHA_SITE_KEY', 'SITE_URL']

let warn: ReturnType<typeof vi.spyOn>

async function load(env: Record<string, string>, dev = false) {
  vi.stubEnv('DEV', dev)
  for (const k of ALL_KEYS) vi.stubEnv(k, '')
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.resetModules()
  const altcha = await import('./spam-altcha')
  altcha._configureForTests({ cost: 10, counterMin: 1, counterMax: 20 })
  return {
    altcha,
    formConfig: await import('../pages/api/form-config'),
    challenge: await import('../pages/api/altcha-challenge'),
    contact: await import('../pages/api/contact'),
  }
}

function ctx(url: string, init: RequestInit & { xff?: string } = {}): any {
  const headers = new Headers(init.headers)
  headers.set('x-forwarded-for', init.xff ?? '1.2.3.4')
  const request = new Request(url, { ...init, headers })
  return { request, url: new URL(url) }
}

function logLines(): string[] {
  return warn.mock.calls.map((c: unknown[]) => c.map(String).join(' '))
}

beforeEach(() => {
  sent.length = 0
  resendRejects = false
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('/api/form-config', () => {
  test('reports altcha when configured, never cached', async () => {
    const { formConfig } = await load(ALTCHA_ENV)
    const res = await formConfig.GET(ctx('http://localhost/api/form-config'))
    expect(await res.json()).toEqual({ provider: 'altcha', recaptchaSiteKey: null })
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
  })

  test('never hands out the reCAPTCHA site key in altcha mode', async () => {
    const { formConfig } = await load({ ...ALTCHA_ENV, PUBLIC_RECAPTCHA_SITE_KEY: 'SK' })
    const res = await formConfig.GET(ctx('http://localhost/api/form-config'))
    expect(await res.json()).toEqual({ provider: 'altcha', recaptchaSiteKey: null })
  })

  test('hands out the reCAPTCHA site key in recaptcha mode', async () => {
    const { formConfig } = await load({ SPAM_PROVIDER: 'recaptcha', PUBLIC_RECAPTCHA_SITE_KEY: 'SK' })
    const res = await formConfig.GET(ctx('http://localhost/api/form-config'))
    expect((await res.json()).recaptchaSiteKey).toBe('SK')
  })

  test('reports none in dev when the provider is not configured', async () => {
    const { formConfig } = await load({ SPAM_PROVIDER: 'altcha' }, true)
    const res = await formConfig.GET(ctx('http://localhost/api/form-config'))
    expect((await res.json()).provider).toBe('none')
  })

  test('reports null for an unknown provider in production', async () => {
    const { formConfig } = await load({ SPAM_PROVIDER: 'hcaptcha' })
    const res = await formConfig.GET(ctx('http://localhost/api/form-config'))
    expect((await res.json()).provider).toBeNull()
  })
})

describe('/api/altcha-challenge', () => {
  test('503 in reCAPTCHA mode', async () => {
    const { challenge } = await load({ SPAM_PROVIDER: 'recaptcha' })
    expect((await challenge.GET(ctx('http://localhost/api/altcha-challenge'))).status).toBe(503)
  })

  test('503 in altcha mode without a secret', async () => {
    const { challenge } = await load({ SPAM_PROVIDER: 'altcha' })
    expect((await challenge.GET(ctx('http://localhost/api/altcha-challenge'))).status).toBe(503)
  })

  test('returns a fresh, uncached challenge', async () => {
    const { challenge } = await load(ALTCHA_ENV)
    const res = await challenge.GET(ctx('http://localhost/api/altcha-challenge'))
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
    expect(typeof (await res.json()).parameters.nonce).toBe('string')
  })

  test('the 21st challenge from one client is limited', async () => {
    const { challenge } = await load(ALTCHA_ENV)
    for (let i = 0; i < 20; i++) {
      expect((await challenge.GET(ctx('http://localhost/api/altcha-challenge'))).status).toBe(200)
    }
    const res = await challenge.GET(ctx('http://localhost/api/altcha-challenge'))
    expect(res.status).toBe(429)
    expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
  })

  test('one client hammering the endpoint cannot use up the site-wide budget', async () => {
    const { challenge } = await load(ALTCHA_ENV)
    for (let i = 0; i < 601; i++) await challenge.GET(ctx('http://localhost/api/altcha-challenge', { xff: '6.6.6.6' }))
    const res = await challenge.GET(ctx('http://localhost/api/altcha-challenge', { xff: '7.7.7.7' }))
    expect(res.status).toBe(200)
  })

  test('the site-wide cap limits challenges across clients', async () => {
    const { challenge } = await load(ALTCHA_ENV)
    const limits = await import('./spam-ratelimit')
    for (let i = 0; i < 600; i++) limits.challengeGlobal.record('all')
    const res = await challenge.GET(ctx('http://localhost/api/altcha-challenge', { xff: '9.9.9.9' }))
    expect(res.status).toBe(429)
  })
})

describe('/api/altcha-challenge?fail=', () => {
  test('a known reason is logged once and answered with 204', async () => {
    const { challenge } = await load(ALTCHA_ENV)
    const res = await challenge.GET(ctx('http://localhost/api/altcha-challenge?fail=solve'))
    expect(res.status).toBe(204)
    expect(logLines()).toEqual(['[spam-guard] client-fail reason=solve'])
  })

  test('an unknown reason is not logged', async () => {
    const { challenge } = await load(ALTCHA_ENV)
    const res = await challenge.GET(ctx('http://localhost/api/altcha-challenge?fail=%3Cscript%3E'))
    expect(res.status).toBe(204)
    expect(logLines()).toEqual([])
  })

  test('reports work in reCAPTCHA mode too (the client may fail before it knows)', async () => {
    const { challenge } = await load({ SPAM_PROVIDER: 'recaptcha' })
    expect((await challenge.GET(ctx('http://localhost/api/altcha-challenge?fail=config'))).status).toBe(204)
    expect(logLines()).toEqual(['[spam-guard] client-fail reason=config'])
  })

  test('reports count against the per-client challenge limit', async () => {
    const { challenge } = await load(ALTCHA_ENV)
    for (let i = 0; i < 21; i++) await challenge.GET(ctx('http://localhost/api/altcha-challenge?fail=solve'))
    expect(logLines()).toHaveLength(20)
  })
})

describe('/api/contact', () => {
  async function post(contact: any, fields: Record<string, string>): Promise<Response> {
    return contact.POST(
      ctx('http://localhost/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      })
    )
  }
  const BASE = { name: 'Anna', email: 'anna@kund.se', message: 'Hej, jag vill ha en offert.' }

  test('a flagged message is sent with the [misstänkt spam] subject prefix', async () => {
    const { altcha, contact } = await load(ALTCHA_ENV)
    const altchaValue = await solvePayload(await altcha.createAltchaChallenge())
    const res = await post(contact, { ...BASE, message: 'https://a.se https://b.se https://c.se', altcha: altchaValue })
    expect(res.status).toBe(200)
    expect(sent.map((m) => m.subject)).toEqual(['[misstänkt spam] Kontaktformulär: Anna'])
  })

  test('an unflagged message keeps its subject', async () => {
    const { altcha, contact } = await load(ALTCHA_ENV)
    const altchaValue = await solvePayload(await altcha.createAltchaChallenge())
    const res = await post(contact, { ...BASE, altcha: altchaValue })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8')
    expect(sent.map((m) => m.subject)).toEqual(['Kontaktformulär: Anna'])
  })

  test('a send Resend rejects is a failure, not a false success', async () => {
    const { altcha, contact } = await load(ALTCHA_ENV)
    resendRejects = true
    const altchaValue = await solvePayload(await altcha.createAltchaChallenge())
    const res = await post(contact, { ...BASE, altcha: altchaValue })
    expect(res.status).toBe(500)
    expect((await res.json()).success).toBe(false)
  })

  test('a post without a solution is rejected and nothing is sent', async () => {
    const { contact } = await load(ALTCHA_ENV)
    const res = await post(contact, BASE)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Verifiering misslyckades. Försök igen.')
    expect(sent).toEqual([])
  })

  function formPost(contact: any, fields: Record<string, string>, headers: Record<string, string>): Promise<Response> {
    return contact.POST(
      ctx('http://localhost/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
        body: new URLSearchParams(fields).toString(),
      })
    )
  }
  const BROWSER = { Accept: 'text/html,application/xhtml+xml,*/*;q=0.8', Referer: 'https://kund.se/kontakt/' }

  test('a post without JavaScript goes back to the form with #fel, not to raw JSON', async () => {
    const { contact } = await load(ALTCHA_ENV)
    const res = await formPost(contact, BASE, BROWSER)
    expect([res.status, res.headers.get('Location')]).toEqual([303, '/kontakt/#fel'])
    expect(sent).toEqual([])
  })

  test('a verified browser form post goes back with #skickat', async () => {
    const { altcha, contact } = await load(ALTCHA_ENV)
    const altchaValue = await solvePayload(await altcha.createAltchaChallenge())
    const res = await formPost(contact, { ...BASE, altcha: altchaValue }, BROWSER)
    expect([res.status, res.headers.get('Location')]).toEqual([303, '/kontakt/#skickat'])
    expect(sent.map((m) => m.subject)).toEqual(['Kontaktformulär: Anna'])
  })

  test("a second form's FormStatus name comes back in the fragment", async () => {
    const { contact } = await load(ALTCHA_ENV)
    const res = await formPost(contact, { ...BASE, form_status: 'offert' }, BROWSER)
    expect(res.headers.get('Location')).toBe('/kontakt/#offert-fel')
  })

  test("without a Referer, the form's own return path (form_return) still leads back to it", async () => {
    const { contact } = await load(ALTCHA_ENV)
    const res = await formPost(contact, { ...BASE, form_return: '/tjanster/' }, { Accept: 'text/html' })
    expect(res.headers.get('Location')).toBe('/tjanster/#fel')
  })

  test('a thrown error still sends a no-JS visitor back to #fel, not to a bare 500 page', async () => {
    vi.doMock('./spam-guard', () => ({
      checkSubmission: () => { throw new Error('boom') },
      checkResponse: () => null,
    }))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const { contact } = await load(ALTCHA_ENV)
      const res = await formPost(contact, BASE, BROWSER)
      expect([res.status, res.headers.get('Location')]).toEqual([303, '/kontakt/#fel'])
    } finally {
      vi.doUnmock('./spam-guard')
    }
  })

  test('a script posting form data (no Accept: text/html) still gets JSON', async () => {
    const { contact } = await load(ALTCHA_ENV)
    const res = await formPost(contact, BASE, { Accept: '*/*' })
    expect(res.status).toBe(400)
    expect((await res.json()).success).toBe(false)
  })
})
