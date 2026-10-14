import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

type Mod = typeof import('../src/lib/spam-recaptcha')

/** Import a fresh copy with production behaviour (DEV false). */
async function load(env: Record<string, string> = {}): Promise<Mod> {
  vi.stubEnv('DEV', false)
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  vi.resetModules()
  return import('../src/lib/spam-recaptcha')
}

const KEYS = {
  RECAPTCHA_SECRET_KEY: 'sec',
  PUBLIC_RECAPTCHA_SITE_KEY: 'site',
  SITE_URL: 'https://kund.example',
}

function google(body: object): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body)))
}

const GOOD = { success: true, score: 0.9, action: 'contact', hostname: 'www.kund.example' }

beforeEach(() => {
  for (const k of [...Object.keys(KEYS), 'RECAPTCHA_ALLOWED_HOSTS']) vi.stubEnv(k, '')
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('missingRecaptchaKeys', () => {
  test('lists every missing key', async () => {
    const m = await load()
    expect(m.missingRecaptchaKeys()).toBe('RECAPTCHA_SECRET_KEY, PUBLIC_RECAPTCHA_SITE_KEY, SITE_URL')
  })

  test('the placeholder site URL counts as missing', async () => {
    const m = await load({ ...KEYS, SITE_URL: 'https://example.com' })
    expect(m.missingRecaptchaKeys()).toBe('SITE_URL')
  })

  test('null when everything is set', async () => {
    const m = await load(KEYS)
    expect(m.missingRecaptchaKeys()).toBeNull()
  })
})

describe('verifyRecaptchaToken', () => {
  test('no token', async () => {
    const m = await load(KEYS)
    expect(await m.verifyRecaptchaToken('', 'contact')).toEqual({ status: 'rejected', detail: 'no-token' })
    expect(await m.verifyRecaptchaToken(undefined, 'contact')).toEqual({ status: 'rejected', detail: 'no-token' })
  })

  test('Google unreachable', async () => {
    const m = await load(KEYS)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'))
    expect(await m.verifyRecaptchaToken('t', 'contact')).toEqual({ status: 'rejected', detail: 'unreachable' })
  })

  test('invalid secret is misconfiguration', async () => {
    const m = await load(KEYS)
    vi.spyOn(console, 'error').mockImplementation(() => {})
    google({ success: false, 'error-codes': ['invalid-input-secret'] })
    expect(await m.verifyRecaptchaToken('t', 'contact')).toEqual({ status: 'misconfigured', detail: 'invalid-secret' })
  })

  test('other Google errors', async () => {
    const m = await load(KEYS)
    google({ success: false, 'error-codes': ['timeout-or-duplicate'] })
    expect(await m.verifyRecaptchaToken('t', 'contact')).toEqual({
      status: 'rejected',
      detail: 'errors:timeout-or-duplicate',
    })
  })

  test('low score', async () => {
    const m = await load(KEYS)
    google({ ...GOOD, score: 0.3 })
    expect(await m.verifyRecaptchaToken('t', 'contact')).toEqual({ status: 'rejected', detail: 'score' })
  })

  test('wrong action', async () => {
    const m = await load(KEYS)
    google({ ...GOOD, action: 'login' })
    expect(await m.verifyRecaptchaToken('t', 'contact')).toEqual({ status: 'rejected', detail: 'action' })
  })

  test('foreign hostname', async () => {
    const m = await load(KEYS)
    google({ ...GOOD, hostname: 'evil.example' })
    expect(await m.verifyRecaptchaToken('t', 'contact')).toEqual({ status: 'rejected', detail: 'hostname' })
  })

  test('valid token', async () => {
    const m = await load(KEYS)
    google(GOOD)
    expect(await m.verifyRecaptchaToken('t', 'contact')).toEqual({ status: 'ok' })
  })

  test('does not log rejections itself — the coordinator does', async () => {
    const m = await load(KEYS)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    google({ ...GOOD, score: 0.1 })
    await m.verifyRecaptchaToken('t', 'contact')
    await m.verifyRecaptchaToken('', 'contact')
    expect(warn).not.toHaveBeenCalled()
  })
})
