// reCAPTCHA v3 verification for the spam guard (provider 'recaptcha').
//
// Fails closed: a missing token, low score, wrong action, foreign hostname or
// an unreachable Google all reject. The verdict carries a short `detail`; the
// coordinator in spam-guard.ts writes the one log line per rejection.

import { env } from './runtime-env'

const MIN_SCORE = 0.5
const VERIFY_URL = 'https://www.google.com/recaptcha/api/siteverify'
const VERIFY_TIMEOUT_MS = 5000

/** astro.config's fallback `site` — a placeholder, not a real host. */
const PLACEHOLDER_HOST = 'example.com'

/** Outcome of a provider check, shared by every provider. */
export type Verdict =
  | { status: 'ok'; ageS?: number }
  | { status: 'rejected'; detail: string }
  | { status: 'misconfigured'; detail: string }

/** The public site key, read at runtime. Served to the browser by /api/form-config. */
export function recaptchaSiteKey(): string | undefined {
  return env('PUBLIC_RECAPTCHA_SITE_KEY')
}

interface VerifyResponse {
  success: boolean
  score?: number
  action?: string
  hostname?: string
  'error-codes'?: string[]
}

/** Lowercase, punycode (so exempel-åäö.example matches xn--…), without www. */
function normalizeHost(host: string): string {
  let ascii = host.trim().toLowerCase()
  try {
    ascii = new URL(`https://${ascii}`).hostname
  } catch {
    // Not a valid hostname — compare as-is, it won't match an allowed host
  }
  return ascii.replace(/^www\./, '')
}

/**
 * Hostnames a token may come from. The shared reCAPTCHA key has Google's
 * domain verification turned off, so this check is what stops the key being
 * reused on other sites. Uses SITE_URL, falling back to astro.config's `site`.
 * Returns null when neither gives a real host — the caller treats that as
 * missing configuration.
 */
function allowedHosts(): Set<string> | null {
  const siteUrl = env('SITE_URL') ?? import.meta.env.SITE
  let siteHost: string
  try {
    siteHost = normalizeHost(new URL(siteUrl ?? '').hostname)
  } catch {
    return null
  }
  if (!siteHost || siteHost === PLACEHOLDER_HOST) return null

  const hosts = new Set([siteHost])
  for (const extra of (env('RECAPTCHA_ALLOWED_HOSTS') ?? '').split(',')) {
    if (extra.trim()) hosts.add(normalizeHost(extra))
  }
  if (import.meta.env.DEV) hosts.add('localhost')
  return hosts
}

/** Comma-separated names of the missing reCAPTCHA settings, or null when complete. */
export function missingRecaptchaKeys(): string | null {
  const missing = [
    !env('RECAPTCHA_SECRET_KEY') && 'RECAPTCHA_SECRET_KEY',
    !recaptchaSiteKey() && 'PUBLIC_RECAPTCHA_SITE_KEY',
    !allowedHosts() && 'SITE_URL',
  ].filter(Boolean)
  return missing.length ? missing.join(', ') : null
}

/** Verify a reCAPTCHA v3 token with Google. */
export async function verifyRecaptchaToken(token: unknown, action: string): Promise<Verdict> {
  const secret = env('RECAPTCHA_SECRET_KEY')
  const hosts = allowedHosts()
  if (!secret || !hosts) return { status: 'misconfigured', detail: 'keys' }

  const response = typeof token === 'string' ? token.trim() : ''
  if (!response) return { status: 'rejected', detail: 'no-token' }

  let data: VerifyResponse
  try {
    const res = await fetch(VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret, response }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    })
    data = (await res.json()) as VerifyResponse
  } catch (err) {
    console.error('[spam-guard] reCAPTCHA verify error — rejecting:', err)
    return { status: 'rejected', detail: 'unreachable' }
  }

  if (!data.success) {
    const errors = data['error-codes'] ?? []
    // A bad secret is our fault, not the visitor's — logged as an error here, once.
    if (errors.some((code) => code === 'missing-input-secret' || code === 'invalid-input-secret')) {
      console.error('[spam-guard] RECAPTCHA_SECRET_KEY is invalid — rejecting:', errors)
      return { status: 'misconfigured', detail: 'invalid-secret' }
    }
    return { status: 'rejected', detail: `errors:${errors.join(',')}` }
  }
  if ((data.score ?? 0) < MIN_SCORE) return { status: 'rejected', detail: 'score' }
  if (data.action !== action) return { status: 'rejected', detail: 'action' }
  if (!hosts.has(normalizeHost(data.hostname ?? ''))) return { status: 'rejected', detail: 'hostname' }

  return { status: 'ok' }
}
