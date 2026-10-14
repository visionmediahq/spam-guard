// Server-side spam guard for every form API route.
//
// Call checkSubmission() (or guardSubmission() for starter-shaped JSON routes)
// with the parsed request body before validating or sending anything.
//
// Layers, in order:
// 1. Honeypot — a filled-in hidden field gets a fake success and is dropped,
//    so bots don't learn they were caught.
// 2. Configuration — fails closed: a missing provider setting answers 503
//    instead of sending unverified mail. Only `astro dev` lets posts through.
// 3. Rate limit — 5 verified posts per 10 minutes per client. Only looked at
//    here; a post is counted after it passes the provider check.
// 4. Provider — SPAM_PROVIDER=recaptcha (default, Google reCAPTCHA v3) or
//    altcha (self-hosted proof-of-work, no third party).
// 5. Content rules — never drop; they return a flag and the endpoint prefixes
//    the e-mail subject with "[misstänkt spam] ".
//
// One log line per decision, never message content or a full IP.

import { BlockList, isIP, isIPv4, isIPv6 } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { env } from './runtime-env'
import { altchaConfigured, verifyAltcha } from './spam-altcha'
import { contentFlag, type Flag } from './spam-content'
import { ALTCHA_FIELD, HONEYPOT_FIELD, RECAPTCHA_TOKEN_FIELD } from './spam-fields'
import { submitLimiter } from './spam-ratelimit'
import { missingRecaptchaKeys, verifyRecaptchaToken, type Verdict } from './spam-recaptcha'

export { recaptchaSiteKey } from './spam-recaptcha'

export type Provider = 'recaptcha' | 'altcha'
export type Reason = 'ok' | 'honeypot' | 'misconfigured' | 'rate-limited' | 'failed'
export type Check = { reason: Reason; flag?: Flag; retryAfterS?: number }
export type CheckOptions = {
  /** reCAPTCHA action — must match the one the form used. Default 'contact'. */
  action?: string
  /** Fields holding the free-text message, for the script rule. Default ['message']. */
  messageFields?: string[]
}

export const RATE_LIMITED_TEXT = 'Du har skickat flera meddelanden på kort tid. Vänta en stund och försök igen.'
export const FAILED_TEXT = 'Verifiering misslyckades. Försök igen.'
export const UNAVAILABLE_TEXT =
  'Formuläret är tillfälligt ur funktion. Försök igen senare eller kontakta oss på annat sätt.'

// ---- logging ----

type LogValue = string | number | undefined

/** `[spam-guard] <kind> key=value …` — undefined values are left out. */
export function log(kind: string, data: Record<string, LogValue> = {}): void {
  const pairs = Object.entries(data)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`)
  console.warn(['[spam-guard]', kind, ...pairs].join(' '))
}

const warned = new Set<string>()
function warnOnce(message: string): void {
  if (warned.has(message)) return
  warned.add(message)
  console.warn(message)
}

// ---- client IP ----

// Cloudflare's published ranges, copied 2026-10-04 from
// https://www.cloudflare.com/ips-v4 and https://www.cloudflare.com/ips-v6.
const CLOUDFLARE_V4 = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22', '141.101.64.0/18',
  '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20', '197.234.240.0/22', '198.41.128.0/17',
  '162.158.0.0/15', '104.16.0.0/13', '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
]
const CLOUDFLARE_V6 = [
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32', '2405:8100::/32',
  '2a06:98c0::/29', '2c0f:f248::/32',
]
const CLOUDFLARE_RANGES = new BlockList()
for (const cidr of CLOUDFLARE_V4) {
  const [net = '', prefix] = cidr.split('/')
  CLOUDFLARE_RANGES.addSubnet(net, Number(prefix), 'ipv4')
}
for (const cidr of CLOUDFLARE_V6) {
  const [net = '', prefix] = cidr.split('/')
  CLOUDFLARE_RANGES.addSubnet(net, Number(prefix), 'ipv6')
}

function fromCloudflare(ip: string): boolean {
  const family = isIPv4(ip) ? 'ipv4' : isIPv6(ip) ? 'ipv6' : null
  if (!family) return false
  try {
    return CLOUDFLARE_RANGES.check(ip, family)
  } catch {
    return false
  }
}

/** Trimmed, lowercased; an IPv4-mapped IPv6 address becomes plain IPv4. */
function normalizeIp(ip: string): string {
  const value = ip.trim().toLowerCase()
  const mapped = value.startsWith('::ffff:') ? value.slice(7) : ''
  return mapped && isIPv4(mapped) ? mapped : value
}

/**
 * The visitor's IP. Traefik appends the peer to X-Forwarded-For, so the last hop
 * is the one to trust. Behind Cloudflare that peer is a Cloudflare edge, and the
 * visitor is in CF-Connecting-IP — trusted only when the peer is in Cloudflare's ranges.
 */
export function clientIp(request: Request): string {
  const hops = (request.headers.get('x-forwarded-for') ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean)
  const peer = normalizeIp(hops[hops.length - 1] ?? '')
  if (!peer) {
    warnOnce('[spam-guard] X-Forwarded-For missing — rate limit is per proxy')
    return 'unknown'
  }
  if (fromCloudflare(peer)) {
    const cf = normalizeIp(request.headers.get('cf-connecting-ip') ?? '')
    if (isIP(cf)) return cf
  } else if (request.headers.get('cf-ray')) {
    warnOnce('[spam-guard] cf-ray header from a peer outside CLOUDFLARE_RANGES — ranges may be stale')
  }
  return peer
}

/** The first four groups of an IPv6 address, or null when it can't be parsed. */
function firstFourGroups(ip: string): string[] | null {
  const addr = ip.split('%')[0] ?? ''
  if (!isIPv6(addr)) return null
  const [head = '', tail] = addr.split('::')
  const headGroups = head ? head.split(':') : []
  const tailGroups = tail ? tail.split(':') : []
  // An embedded IPv4 tail (a.b.c.d) is two groups but only ever affects the last groups.
  const filler = Array<string>(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill('0')
  const groups = tail === undefined ? headGroups : [...headGroups, ...filler, ...tailGroups]
  return groups.slice(0, 4).map((g) => (g.includes('.') ? '0' : g.replace(/^0+(?=.)/, '')))
}

/** Rate-limit key: the IP, or its /64 for IPv6 (one visitor usually owns a whole /64). */
export function ipKey(ip: string): string {
  const groups = firstFourGroups(ip)
  return groups ? `${groups.join(':')}::/64` : ip
}

let salt = { day: '', value: '' }

/** Short daily-salted hash of a rate-limit key, so log lines can be grouped without storing IPs. */
export function ipHash(key: string): string {
  const day = new Date().toISOString().slice(0, 10)
  if (salt.day !== day) salt = { day, value: randomBytes(16).toString('hex') }
  return 'h:' + createHash('sha256').update(salt.value + key).digest('hex').slice(0, 6)
}

// ---- configuration ----

export function provider(): Provider | null {
  const value = env('SPAM_PROVIDER') ?? 'recaptcha'
  return value === 'recaptcha' || value === 'altcha' ? value : null
}

/** What is missing for the selected provider, or null. */
export async function missingConfig(): Promise<string | null> {
  const p = provider()
  if (p === null) return 'SPAM_PROVIDER'
  if (p === 'recaptcha') return missingRecaptchaKeys()
  return (await altchaConfigured()) ? null : 'ALTCHA_HMAC_SECRET'
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== ''
}

// ---- the check ----

/**
 * Run all spam checks on a parsed form submission.
 *
 * @param fields   The parsed request body (form data or JSON as a plain object)
 * @param request  The incoming request — required in altcha mode (client IP, rate limit)
 * @param options  reCAPTCHA action and the message field names
 */
export async function checkSubmission(
  fields: Record<string, unknown> | null,
  request?: Request,
  options: CheckOptions = {}
): Promise<Check> {
  const f = fields ?? {}

  // 1. Honeypot. token=yes/no tells a bot hit from an autofilled human.
  if (hasText(f[HONEYPOT_FIELD])) {
    const token = hasText(f[RECAPTCHA_TOKEN_FIELD]) || hasText(f[ALTCHA_FIELD])
    log('honeypot', { token: token ? 'yes' : 'no' })
    return { reason: 'honeypot' }
  }

  // 2. Configuration.
  const p = provider()
  const missing = (await missingConfig()) ?? (p === 'altcha' && !request ? 'request not passed' : null)
  if (missing || !p) {
    if (import.meta.env.DEV) {
      console.warn(`[spam-guard] ${missing} — only the honeypot is active (dev only)`)
      return { reason: 'ok' }
    }
    console.error(`[spam-guard] ${missing} — rejecting submission`)
    return { reason: 'misconfigured' }
  }

  // 3. Rate limit: look only (D11).
  const key = request ? ipKey(clientIp(request)) : null
  if (key) {
    const wait = submitLimiter.wait(key)
    if (wait > 0) {
      log('rejected', { reason: 'rate-limited', ip: ipHash(key) })
      return { reason: 'rate-limited', retryAfterS: wait }
    }
  }

  // 4. Provider.
  const verdict: Verdict =
    p === 'recaptcha'
      ? await verifyRecaptchaToken(f[RECAPTCHA_TOKEN_FIELD], options.action ?? 'contact')
      : await verifyAltcha(f[ALTCHA_FIELD])
  if (verdict.status === 'misconfigured') {
    console.error(`[spam-guard] ${p} misconfigured (${verdict.detail}) — rejecting submission`)
    return { reason: 'misconfigured' }
  }
  if (verdict.status === 'rejected') {
    log('rejected', { reason: 'failed', provider: p, detail: verdict.detail })
    return { reason: 'failed' }
  }

  // 5. Count the verified post; content rules flag only. Looked at again first:
  //    concurrent posts all passed step 3 before any of them was counted, and
  //    this check-and-record has no await in between.
  if (key) {
    const wait = submitLimiter.wait(key)
    if (wait > 0) {
      log('rejected', { reason: 'rate-limited', ip: ipHash(key) })
      return { reason: 'rate-limited', retryAfterS: wait }
    }
    submitLimiter.record(key)
  }
  const flag = request ? contentFlag(f, options.messageFields ?? ['message']) : undefined

  if (p === 'altcha' || flag) log('accepted', { provider: p, age_s: verdict.ageS, flag })
  return flag ? { reason: 'ok', flag } : { reason: 'ok' }
}

function json(body: object, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  })
}

/** The JSON response for a check that must stop the submission, or null to continue. */
export function checkResponse(c: Check): Response | null {
  switch (c.reason) {
    case 'ok':
      return null
    case 'honeypot':
      return json({ success: true }, 200)
    case 'rate-limited':
      return json({ success: false, error: RATE_LIMITED_TEXT }, 429, { 'Retry-After': String(c.retryAfterS ?? 60) })
    case 'failed':
      return json({ success: false, error: FAILED_TEXT }, 400)
    case 'misconfigured':
      return json({ success: false, error: UNAVAILABLE_TEXT }, 503)
  }
}

/**
 * Run all spam checks and map the result to a JSON response.
 * Unchanged for existing 2-argument callers; pass `request` to get the rate limit.
 * Content flags are not returned here — use checkSubmission() for those.
 *
 * @returns A Response to return immediately, or null to continue
 */
export async function guardSubmission(
  fields: Record<string, unknown> | null,
  action = 'contact',
  request?: Request
): Promise<Response | null> {
  return checkResponse(await checkSubmission(fields, request, { action }))
}
