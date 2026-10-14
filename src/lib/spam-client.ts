// Browser side of the spam guard. Import it from a form's <script> tag.
//
//   preloadSpamCheck(form)                  once on load
//   on submit:
//     guard against double submit (a payload is single-use)
//     fields = await getSpamFields(form)    or addSpamToken(form, formData)
//     fetch(...)
//     finally spamSubmitted(form)           always, success or failure
//
// The provider comes from /api/form-config at runtime:
// - 'altcha'    — fetch a signed challenge from /api/altcha-challenge and solve
//                 it in Web Workers (altcha/lib). Solving starts on the first
//                 focus inside the form, so it is usually done before submit.
// - 'recaptcha' — Google reCAPTCHA v3, loaded lazily (one loader per page).
// - 'none'      — `astro dev` without keys: only the honeypot is sent.
// When no solution can be produced (after one silent retry) getSpamFields
// throws SpamCheckError; the form then shows a "ring oss" message. Failures
// are reported to the server as one `client-fail` log line per reason.

import type { Challenge, Solution } from 'altcha/lib'
import pbkdf2WorkerUrl from 'altcha/workers/pbkdf2?url'
import {
  ALTCHA_FIELD,
  FORM_STATUS_CLASS,
  HONEYPOT_FIELD,
  RECAPTCHA_TOKEN_FIELD,
  type ClientFailReason,
} from './spam-fields'

/** Thrown when the browser cannot produce what the server needs. */
export class SpamCheckError extends Error {
  constructor() {
    super('spam check failed')
    this.name = 'SpamCheckError'
  }
}

class TimeoutError extends Error {}

const FORM_CONFIG_URL = '/api/form-config'
const CHALLENGE_URL = '/api/altcha-challenge'
const CONFIG_TIMEOUT_MS = 5000
const SOLVE_TIMEOUT_MS = 6000
const SPAM_FIELDS_TIMEOUT_MS = 15_000
const RECAPTCHA_LOAD_TIMEOUT_MS = 8000
const REFRESH_BEFORE_S = 60

/** Rejects with TimeoutError after `ms`. Plain setTimeout: AbortSignal.timeout is missing on iOS 15. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError()), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err)
      }
    )
  })
}

async function fetchWithTimeout(url: string, ms: number): Promise<Response> {
  const controller = new AbortController()
  return withTimeout(fetch(url, { cache: 'no-store', signal: controller.signal }), ms).catch((err: unknown) => {
    controller.abort()
    throw err
  })
}

// ---- config ----

type Config = { provider: 'recaptcha' | 'altcha' | 'none' | null; recaptchaSiteKey: string | null }

function usable(c: Config | null): c is Config {
  if (!c) return false
  if (c.provider === 'altcha' || c.provider === 'none') return true
  return c.provider === 'recaptcha' && Boolean(c.recaptchaSiteKey)
}

let config: Promise<Config | null> | null = null

/** The provider config, fetched once. A failed or unusable answer is fetched again next time. */
export function getConfig(): Promise<Config | null> {
  config ??= fetchWithTimeout(FORM_CONFIG_URL, CONFIG_TIMEOUT_MS)
    .then((res) => (res.ok ? (res.json() as Promise<Config>) : null))
    .then((c) => {
      if (!usable(c)) config = null
      return c
    })
    .catch(() => {
      config = null
      return null
    })
  return config
}

// ---- failure reports ----

const reported = new Set<ClientFailReason>()

function reportFail(reason: ClientFailReason): void {
  if (reported.has(reason)) return
  reported.add(reason)
  fetch(`${CHALLENGE_URL}?fail=${reason}`, { cache: 'no-store', keepalive: true }).catch(() => {})
}

// ---- reCAPTCHA ----

interface Grecaptcha {
  ready: (cb: () => void) => void
  execute: (siteKey: string, options: { action: string }) => Promise<string>
}

declare global {
  interface Window {
    grecaptcha?: Grecaptcha
  }
}

let recaptchaLoading: Promise<Grecaptcha | null> | null = null

/** Load Google's script once per page. A failed or timed-out load is forgotten and retried. */
export function loadRecaptcha(siteKey: string): Promise<Grecaptcha | null> {
  if (recaptchaLoading) return recaptchaLoading

  const attempt: Promise<Grecaptcha | null> = new Promise((resolve) => {
    const script = document.createElement('script')
    script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(siteKey)}`
    script.async = true

    const fail = (): void => {
      window.clearTimeout(timer)
      if (recaptchaLoading === attempt) recaptchaLoading = null
      resolve(null)
    }
    const timer = window.setTimeout(fail, RECAPTCHA_LOAD_TIMEOUT_MS)

    script.onload = () => {
      const gr = window.grecaptcha
      if (!gr) {
        fail()
        return
      }
      gr.ready(() => {
        window.clearTimeout(timer)
        resolve(gr)
      })
    }
    script.onerror = fail
    document.head.appendChild(script)
  })

  recaptchaLoading = attempt
  return attempt
}

/** A reCAPTCHA token for the action, or '' when Google fails to load or answer. */
export async function recaptchaTokenFor(siteKey: string, action: string): Promise<string> {
  const gr = await loadRecaptcha(siteKey)
  if (!gr) return ''
  try {
    return await gr.execute(siteKey, { action })
  } catch {
    return ''
  }
}

// ---- ALTCHA solver ----

type SolveFn = (options: {
  challenge: Challenge
  concurrency: number
  createWorker: (algorithm: string) => Worker
  timeout?: number
}) => Promise<Solution | null>

let solverOverride: SolveFn | null = null
let solver: Promise<SolveFn | null> | null = null

function loadSolver(): Promise<SolveFn | null> {
  if (solverOverride) return Promise.resolve(solverOverride)
  solver ??= import('altcha/lib')
    .then((m) => m.solveChallengeWorkers as SolveFn)
    .catch(() => {
      solver = null
      return null
    })
  return solver
}

function supported(): boolean {
  return typeof Worker === 'function' && Boolean(globalThis.crypto?.subtle)
}

/** freshUntil is in local clock seconds, so a phone clock that is off does not matter. */
type Solved = { payload: string; freshUntil: number }

async function solveOnce(): Promise<Solved | null> {
  if (!supported()) {
    reportFail('unsupported')
    return null
  }
  const solve = await loadSolver()
  if (!solve) {
    reportFail('load')
    return null
  }
  let challenge: Challenge
  let receivedAt = 0
  try {
    const res = await fetchWithTimeout(CHALLENGE_URL, CONFIG_TIMEOUT_MS)
    if (!res.ok) {
      reportFail('challenge')
      return null
    }
    challenge = (await res.json()) as Challenge
    receivedAt = Date.now() / 1000
  } catch {
    reportFail('challenge')
    return null
  }
  try {
    const solution = await solve({
      challenge,
      timeout: SOLVE_TIMEOUT_MS,
      concurrency: Math.min(navigator.hardwareConcurrency || 2, 4),
      createWorker: () => new Worker(pbkdf2WorkerUrl),
    })
    if (!solution) {
      reportFail('solve')
      return null
    }
    const payload = btoa(
      JSON.stringify({ challenge: { parameters: challenge.parameters, signature: challenge.signature }, solution })
    )
    // Lifetime from the server's own stamps (iat, expiresAt), counted from now on the local clock.
    const { expiresAt, data } = challenge.parameters
    const iat = typeof data?.iat === 'number' ? data.iat / 1000 : null
    const freshUntil =
      expiresAt !== undefined && iat !== null ? receivedAt + (expiresAt - iat) : (expiresAt ?? 0)
    return { payload, freshUntil }
  } catch {
    reportFail('solve')
    return null
  }
}

// ---- per-form state ----

type FormState = { solving: Promise<Solved | null> | null }

const states = new Map<HTMLFormElement, FormState>() // a page has 1–3 forms

function formState(form: HTMLFormElement): FormState {
  let s = states.get(form)
  if (!s) {
    const state: FormState = { solving: null }
    form.addEventListener('reset', () => {
      state.solving = null
    })
    states.set(form, state)
    s = state
  }
  return s
}

// A page restored from the back/forward cache may hold a used or expired solution.
window.addEventListener('pageshow', (event) => {
  if ((event as PageTransitionEvent).persisted) {
    for (const s of states.values()) s.solving = null
  }
})

/** One in-flight solve per form: concurrent callers share it. A failed solve is forgotten. */
function startSolve(s: FormState): Promise<Solved | null> {
  if (!s.solving) {
    const attempt: Promise<Solved | null> = solveOnce().then((r) => {
      if (!r && s.solving === attempt) s.solving = null
      return r
    })
    s.solving = attempt
  }
  return s.solving
}

/** A solution with more than REFRESH_BEFORE_S left; one silent retry (D15, D16). */
async function freshPayload(s: FormState): Promise<string | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await startSolve(s)
    if (r && r.freshUntil - Date.now() / 1000 > REFRESH_BEFORE_S) return r.payload
    s.solving = null
  }
  return null
}

// ---- public API ----

async function prepare(form: HTMLFormElement): Promise<void> {
  const cfg = await getConfig()
  if (cfg?.provider === 'recaptcha' && cfg.recaptchaSiteKey) void loadRecaptcha(cfg.recaptchaSiteKey)
  if (cfg?.provider === 'altcha') void startSolve(formState(form))
}

/** Start the spam check as soon as the visitor interacts with the form. */
export function preloadSpamCheck(form: HTMLFormElement): void {
  form.addEventListener('focusin', () => void prepare(form), { once: true })
}

async function collect(form: HTMLFormElement, action: string): Promise<Record<string, string>> {
  const honeypot = form.elements.namedItem(HONEYPOT_FIELD)
  const out: Record<string, string> = {
    [HONEYPOT_FIELD]: honeypot instanceof HTMLInputElement ? honeypot.value : '',
  }
  const cfg = await getConfig()
  if (!usable(cfg)) {
    reportFail('config')
    throw new SpamCheckError()
  }
  if (cfg.provider === 'none') return out
  if (cfg.provider === 'recaptcha') {
    const token = await recaptchaTokenFor(cfg.recaptchaSiteKey ?? '', action)
    if (token) out[RECAPTCHA_TOKEN_FIELD] = token
    return out
  }
  const payload = await freshPayload(formState(form))
  if (!payload) throw new SpamCheckError()
  out[ALTCHA_FIELD] = payload
  return out
}

/**
 * The extra fields the server needs (honeypot plus a reCAPTCHA token or an ALTCHA
 * payload). Works for FormData and hand-built JSON alike.
 *
 * @throws SpamCheckError when no solution could be produced
 */
export async function getSpamFields(form: HTMLFormElement, action = 'contact'): Promise<Record<string, string>> {
  // The send has started: a stale #fel from an earlier no-JS post must not show while it runs.
  hideFormStatus(form)
  try {
    return await withTimeout(collect(form, action), SPAM_FIELDS_TIMEOUT_MS)
  } catch (err) {
    if (err instanceof TimeoutError) {
      reportFail('timeout')
      throw new SpamCheckError()
    }
    throw err
  }
}

/** Write the spam fields into a FormData submission. */
export async function addSpamToken(form: HTMLFormElement, data: FormData, action = 'contact'): Promise<void> {
  for (const [key, value] of Object.entries(await getSpamFields(form, action))) data.set(key, value)
}

/**
 * Hides the form's <FormStatus /> blocks (the reply to a no-JS post, shown via :target), so a
 * stale #fel in the address never contradicts the send the script is making or has made.
 */
function hideFormStatus(form: HTMLFormElement): void {
  form.querySelectorAll<HTMLElement>(`.${FORM_STATUS_CLASS}`).forEach((el) => {
    el.style.display = 'none'
  })
}

/**
 * Call after EVERY submit attempt: a payload is single-use, so a fresh one is solved for a retry.
 * Also hides the form's <FormStatus /> blocks (getSpamFields already did at the start of the send).
 */
export function spamSubmitted(form: HTMLFormElement): void {
  hideFormStatus(form)
  const s = states.get(form)
  if (!s) return
  s.solving = null
  void startSolve(s)
}

/** Test hook: replace the dynamically imported solver. */
export function _setSolverForTests(fn: SolveFn | null): void {
  solverOverride = fn
}
