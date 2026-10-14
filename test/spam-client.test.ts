// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

type Client = typeof import('../src/lib/spam-client')
type Config = { provider: string | null; recaptchaSiteKey: string | null }

let calls: string[]
let config: Config | 'fail'
let challengeStatus: number
let challengeTtlS: number
let nonce: number
let solver: ReturnType<typeof vi.fn>

function nowS(): number {
  return Math.floor(Date.now() / 1000)
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.startsWith('/api/form-config')) {
        if (config === 'fail') throw new TypeError('network')
        return new Response(JSON.stringify(config))
      }
      if (url.startsWith('/api/altcha-challenge?fail=')) return new Response(null, { status: 204 })
      if (url.startsWith('/api/altcha-challenge')) {
        if (challengeStatus !== 200) return new Response('{}', { status: challengeStatus })
        nonce++
        return new Response(
          JSON.stringify({ parameters: { nonce: `n${nonce}`, expiresAt: nowS() + challengeTtlS }, signature: `s${nonce}` })
        )
      }
      throw new Error(`unexpected fetch ${url}`)
    })
  )
}

async function load(): Promise<Client> {
  vi.resetModules()
  const c = await import('../src/lib/spam-client')
  c._setSolverForTests(solver as never)
  return c
}

function makeForm(): HTMLFormElement {
  const form = document.createElement('form')
  form.innerHTML = '<input name="hp_x7q2" value="" /><input name="message" value="Hej" />'
  document.body.appendChild(form)
  return form
}

function decodePayload(raw: string): any {
  return JSON.parse(atob(raw))
}

function failReports(): string[] {
  return calls.filter((u) => u.includes('?fail=')).map((u) => u.split('?fail=')[1] ?? '')
}

beforeEach(() => {
  calls = []
  config = { provider: 'altcha', recaptchaSiteKey: null }
  challengeStatus = 200
  challengeTtlS = 7200
  nonce = 0
  solver = vi.fn(async () => ({ counter: 1, derivedKey: 'ab' }))
  installFetch()
  vi.stubGlobal('Worker', class {})
  document.body.innerHTML = ''
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('getSpamFields — providers', () => {
  test("provider 'none' sends only the honeypot and fetches no challenge", async () => {
    config = { provider: 'none', recaptchaSiteKey: null }
    const c = await load()
    expect(await c.getSpamFields(makeForm())).toEqual({ hp_x7q2: '' })
    expect(calls.some((u) => u.startsWith('/api/altcha-challenge'))).toBe(false)
  })

  test("provider 'altcha' adds a payload with the challenge and the solution", async () => {
    const c = await load()
    const fields = await c.getSpamFields(makeForm())
    expect(fields.hp_x7q2).toBe('')
    expect(decodePayload(fields.altcha!)).toEqual({
      challenge: { parameters: { nonce: 'n1', expiresAt: expect.any(Number) }, signature: 's1' },
      solution: { counter: 1, derivedKey: 'ab' },
    })
  })

  test('a failed config fetch throws, reports once and is retried next time', async () => {
    config = 'fail'
    const c = await load()
    const form = makeForm()
    await expect(c.getSpamFields(form)).rejects.toBeInstanceOf(c.SpamCheckError)
    await expect(c.getSpamFields(form)).rejects.toBeInstanceOf(c.SpamCheckError)
    expect(failReports()).toEqual(['config'])
    config = { provider: 'altcha', recaptchaSiteKey: null }
    expect((await c.getSpamFields(form)).altcha).toBeTruthy()
    expect(calls.filter((u) => u.startsWith('/api/form-config'))).toHaveLength(3)
  })
})

describe('getSpamFields — solving', () => {
  test('two concurrent calls on one form share one solve', async () => {
    const c = await load()
    const form = makeForm()
    const [a, b] = await Promise.all([c.getSpamFields(form), c.getSpamFields(form)])
    expect(a.altcha).toBe(b.altcha)
    expect(solver).toHaveBeenCalledTimes(1)
  })

  test('one failed solve is retried silently', async () => {
    solver.mockResolvedValueOnce(null)
    const c = await load()
    expect((await c.getSpamFields(makeForm())).altcha).toBeTruthy()
    expect(solver).toHaveBeenCalledTimes(2)
  })

  test('two failed solves throw and report solve once', async () => {
    solver.mockResolvedValue(null)
    const c = await load()
    await expect(c.getSpamFields(makeForm())).rejects.toBeInstanceOf(c.SpamCheckError)
    expect(solver).toHaveBeenCalledTimes(2)
    expect(failReports()).toEqual(['solve'])
  })

  test('a solver that throws counts as a failed solve', async () => {
    solver.mockRejectedValueOnce(new Error('boom'))
    const c = await load()
    expect((await c.getSpamFields(makeForm())).altcha).toBeTruthy()
  })

  test('a cached solution with less than 60 s left is solved again', async () => {
    challengeTtlS = 30
    const c = await load()
    const form = makeForm()
    c.preloadSpamCheck(form)
    form.dispatchEvent(new FocusEvent('focusin'))
    await vi.waitFor(() => expect(solver).toHaveBeenCalledTimes(1))
    challengeTtlS = 7200
    const fields = await c.getSpamFields(form)
    expect(decodePayload(fields.altcha!).challenge.signature).toBe('s2')
  })

  test('a phone clock hours ahead of the server can still submit', async () => {
    const c = await load()
    const realNow = Date.now
    const serverNowMs = realNow()
    // The server stamps iat/expiresAt from its own clock; the phone is 3 hours ahead.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.startsWith('/api/form-config')) return new Response(JSON.stringify(config))
      nonce++
      return new Response(JSON.stringify({
        parameters: { nonce: `n${nonce}`, expiresAt: Math.floor(serverNowMs / 1000) + 7200, data: { iat: serverNowMs } },
        signature: `s${nonce}`,
      }))
    }))
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 3 * 3600_000)
    const fields = await c.getSpamFields(makeForm())
    expect(fields.altcha).toBeTruthy()
    expect(solver).toHaveBeenCalledTimes(1)
  })

  test('back/forward cache and form reset clear the cached solution (Review Focus 1)', async () => {
    const c = await load()
    const form = makeForm()
    const first = (await c.getSpamFields(form)).altcha
    const pageshow = new Event('pageshow')
    Object.defineProperty(pageshow, 'persisted', { value: true })
    window.dispatchEvent(pageshow)
    const second = (await c.getSpamFields(form)).altcha
    expect(second).not.toBe(first)
    form.dispatchEvent(new Event('reset'))
    const third = (await c.getSpamFields(form)).altcha
    expect(third).not.toBe(second)
  })

  test('a pageshow that is not from the cache keeps the solution', async () => {
    const c = await load()
    const form = makeForm()
    const first = (await c.getSpamFields(form)).altcha
    window.dispatchEvent(new Event('pageshow'))
    expect((await c.getSpamFields(form)).altcha).toBe(first)
  })

  test('two forms on one page get their own solutions (Review Focus 2)', async () => {
    const c = await load()
    const a = makeForm()
    const b = makeForm()
    const pa = (await c.getSpamFields(a)).altcha
    const pb = (await c.getSpamFields(b)).altcha
    expect(pa).not.toBe(pb)
    c.spamSubmitted(a)
    expect((await c.getSpamFields(b)).altcha).toBe(pb)
  })

  test('getSpamFields hides the no-JS result blocks as the send starts', async () => {
    const c = await load()
    const form = makeForm()
    form.insertAdjacentHTML('beforeend', '<p class="form-status" id="fel">x</p>')
    const pending = c.getSpamFields(form)
    expect((form.querySelector('.form-status') as HTMLElement).style.display).toBe('none')
    await pending
  })

  test('spamSubmitted hides the no-JS result blocks so a stale #fel never contradicts the script', async () => {
    const c = await load()
    const form = makeForm()
    form.insertAdjacentHTML('beforeend', '<p class="form-status" id="fel">x</p>')
    const other = document.createElement('p')
    other.className = 'form-status'
    document.body.append(other)
    c.spamSubmitted(form)
    expect((form.querySelector('.form-status') as HTMLElement).style.display).toBe('none')
    expect(other.style.display).toBe('') // another form's blocks are left alone
  })

  test('spamSubmitted starts a fresh solve right away', async () => {
    const c = await load()
    const form = makeForm()
    const first = (await c.getSpamFields(form)).altcha
    c.spamSubmitted(form)
    await vi.waitFor(() => expect(solver).toHaveBeenCalledTimes(2))
    expect((await c.getSpamFields(form)).altcha).not.toBe(first)
    expect(solver).toHaveBeenCalledTimes(2)
  })

  test('the overall timeout throws and reports timeout', async () => {
    vi.useFakeTimers()
    solver.mockImplementation(() => new Promise(() => {}))
    const c = await load()
    const result = c.getSpamFields(makeForm()).catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await result).toBeInstanceOf(c.SpamCheckError)
    expect(failReports()).toContain('timeout')
  })

  test('a browser without workers throws and reports unsupported', async () => {
    vi.stubGlobal('Worker', undefined)
    const c = await load()
    await expect(c.getSpamFields(makeForm())).rejects.toBeInstanceOf(c.SpamCheckError)
    expect(failReports()).toEqual(['unsupported'])
    expect(solver).not.toHaveBeenCalled()
  })

  test('a challenge error throws and reports challenge once', async () => {
    challengeStatus = 503
    const c = await load()
    await expect(c.getSpamFields(makeForm())).rejects.toBeInstanceOf(c.SpamCheckError)
    expect(failReports()).toEqual(['challenge'])
  })

  test('addSpamToken writes the fields into FormData', async () => {
    const c = await load()
    const form = makeForm()
    const data = new FormData(form)
    await c.addSpamToken(form, data)
    expect(data.get('altcha')).toBeTruthy()
    expect(data.get('hp_x7q2')).toBe('')
  })
})

describe('reCAPTCHA provider', () => {
  function fakeGoogle(): void {
    const exec = vi.fn(async (_key: string, opts: { action: string }) => `tok-${opts.action}`)
    vi.spyOn(document.head, 'appendChild').mockImplementation(<T extends Node>(node: T): T => {
      ;(window as any).grecaptcha = { ready: (cb: () => void) => cb(), execute: exec }
      queueMicrotask(() => (node as unknown as HTMLScriptElement).onload?.(new Event('load')))
      return node
    })
  }

  test('the token is added under recaptcha_token', async () => {
    config = { provider: 'recaptcha', recaptchaSiteKey: 'SK' }
    fakeGoogle()
    const c = await load()
    expect(await c.getSpamFields(makeForm(), 'offert')).toEqual({ hp_x7q2: '', recaptcha_token: 'tok-offert' })
  })

  test('the Google script is loaded once even through both helpers', async () => {
    config = { provider: 'recaptcha', recaptchaSiteKey: 'SK' }
    fakeGoogle()
    const c = await load()
    const compat = await import('../src/lib/recaptcha-client')
    const form = makeForm()
    c.preloadSpamCheck(form)
    compat.preloadRecaptcha(form)
    form.dispatchEvent(new FocusEvent('focusin'))
    await c.getSpamFields(form)
    expect(await compat.getRecaptchaToken('contact')).toBe('tok-contact')
    expect(document.head.appendChild).toHaveBeenCalledTimes(1)
  })

  test('the compat layer never loads Google outside recaptcha mode', async () => {
    config = { provider: 'altcha', recaptchaSiteKey: 'SK' }
    fakeGoogle()
    await load()
    const compat = await import('../src/lib/recaptcha-client')
    expect(await compat.getRecaptchaToken()).toBe('')
    const data = new FormData()
    await compat.addRecaptchaToken(data)
    expect(data.has('recaptcha_token')).toBe(false)
    expect(document.head.appendChild).not.toHaveBeenCalled()
  })

  test('the compat layer keeps its exports and returns empty without a key', async () => {
    config = { provider: 'recaptcha', recaptchaSiteKey: null }
    await load()
    const compat = await import('../src/lib/recaptcha-client')
    expect(typeof compat.preloadRecaptcha).toBe('function')
    expect(typeof compat.addRecaptchaToken).toBe('function')
    expect(await compat.getRecaptchaToken()).toBe('')
    const data = new FormData()
    await compat.addRecaptchaToken(data)
    expect(data.has('recaptcha_token')).toBe(false)
  })
})
