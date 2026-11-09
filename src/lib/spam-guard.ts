// Server-side spam guard for every form API route.
//
// Call checkSubmission() (or guardSubmission() for JSON routes that need no flag)
// with the parsed request body before validating or sending anything.
//
// Layers, in order:
// 1. Honeypot — a filled-in hidden field with no token gets a fake success and is
//    dropped, so bots don't learn they were caught. With a token it may be a
//    password manager's autofill: the provider decides. A verified post is sent
//    with the flag 'honeypot' only if the honeypot holds a copy of another field
//    (autofill copies the visitor's name, e-mail or phone); a value of its own
//    means a bot that solves the challenge, and it gets the fake success.
// 2. Configuration — fails closed: a missing provider setting answers 503
//    instead of sending unverified mail. Only `astro dev` lets posts through.
// 3. Rate limit — 5 verified posts per 10 minutes per client. Only looked at
//    here; a post is counted after it passes the provider check.
// 4. Provider — SPAM_PROVIDER=recaptcha (default, Google reCAPTCHA v3) or
//    altcha (self-hosted proof-of-work, no third party).
// 5. Sender blocklist — SPAM_BLOCK (and options.block): a verified post from a
//    listed e-mail address, domain or phone number gets the fake success and is
//    dropped. It still counts toward the rate limit.
// 6. Content rules — never drop; they return a flag and the endpoint prefixes
//    the e-mail subject with "[misstänkt spam] ".
//
// One log line per decision, never message content or a full IP.

import { BlockList, isIP, isIPv4, isIPv6 } from 'node:net'
import { createHash, randomBytes } from 'node:crypto'
import { env } from './runtime-env'
import { altchaConfigured, verifyAltcha } from './spam-altcha'
import { contentFlag, type Flag } from './spam-content'
import { ALTCHA_FIELD, HONEYPOT_FIELD, RECAPTCHA_TOKEN_FIELD, SPAM_FIELDS } from './spam-fields'
import { submitLimiter } from './spam-ratelimit'
import { missingRecaptchaKeys, verifyRecaptchaToken, type Verdict } from './spam-recaptcha'

export { recaptchaSiteKey } from './spam-recaptcha'

export type Provider = 'recaptcha' | 'altcha'
export type Reason = 'ok' | 'honeypot' | 'misconfigured' | 'rate-limited' | 'failed'
/** A content rule, or 'honeypot' for a verified post whose honeypot was filled (autofill). */
export type CheckFlag = Flag | 'honeypot'
export type Check = { reason: Reason; flag?: CheckFlag; retryAfterS?: number }
export type CheckOptions = {
  /** reCAPTCHA action — must match the one the form used. Default 'contact'. */
  action?: string
  /**
   * Fields holding the free-text message, for the script rule. Default ['message'].
   * The sender blocklist skips them, so a customer quoting a blocked address isn't dropped.
   */
  messageFields?: string[]
  /** Blocklist entries on top of SPAM_BLOCK, in the same form: 'email:a@b.se', 'email:@b.se', 'phone:070…'. */
  block?: string[]
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
 * The visitor's IP. The reverse proxy appends the peer to X-Forwarded-For, so the
 * last hop is the one to trust. Behind Cloudflare that peer is a Cloudflare edge, and the
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

const MIN_AUTOFILL_CHARS = 3
// No autofill value (a name, an e-mail address, a phone number, an address) is longer. Comparing
// a longer honeypot would only cost time: the phone comparison grows with the square of the input.
const MAX_AUTOFILL_CHARS = 254
// Free text (more words or characters than a name, e-mail or phone): a short honeypot would
// match almost any, so only a honeypot of MIN_IN_LONG_TEXT_CHARS or more counts there.
const SHORT_VALUE_WORDS = 6 // a long Swedish name: Anna-Karin Maria Louise af Ugglas
const SHORT_VALUE_CHARS = 80
const MIN_IN_LONG_TEXT_CHARS = 6
const MIN_PHONE_DIGITS = 6
const MIN_PHONE_SUFFIX_DIGITS = 7
const PHONE_RUN = /\+?\d[\d\s().\-/]{4,}\d/g

/** NFKC, lower case, letters, digits and '@' only: "Åsa B." → "åsab", "a.b@c.se" → "ab@cse". */
function normalise(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}@]/gu, '')
}

/**
 * The phone numbers in a value as national significant numbers, so
 * "+46 8 12 34 56", "0046 8 12 34 56", "+46 (0)8 12 34 56" and "08-12 34 56" are all "8123456".
 */
function phoneNumbers(value: string): string[] {
  return (value.normalize('NFKC').match(PHONE_RUN) ?? [])
    .map((run) => {
      const plus = run.startsWith('+')
      let digits = run.replace(/\(0\)/g, '').replace(/\D/g, '')
      if (plus && digits.startsWith('46')) digits = digits.slice(2)
      else if (digits.startsWith('0046')) digits = digits.slice(4)
      return digits.replace(/^0/, '')
    })
    .filter((digits) => digits.length >= MIN_PHONE_DIGITS)
}

function samePhone(a: string, b: string): boolean {
  if (a === b) return true
  const [short, long] = a.length < b.length ? [a, b] : [b, a]
  return short.length >= MIN_PHONE_SUFFIX_DIGITS && long.endsWith(short) // a foreign country code
}

const MAX_DEPTH = 3

/** A field's string values: strings and numbers, also inside arrays and nested JSON objects. */
function stringsOf(value: unknown, depth = 0): string[] {
  if (typeof value === 'string' || typeof value === 'number') return [String(value)]
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return []
  return Object.values(value).flatMap((v) => stringsOf(v, depth + 1))
}

/**
 * Whether the honeypot holds a copy of another field, as a password manager's
 * autofill does (the visitor's name, e-mail or phone, possibly only part of it).
 * Bots that solve the challenge write a value of their own.
 */
function looksAutofilled(fields: Record<string, unknown>): boolean {
  const raw = String(fields[HONEYPOT_FIELD])
  if (raw.length > MAX_AUTOFILL_CHARS) return false
  const hp = normalise(raw)
  if (hp.replace(/@/g, '').length < MIN_AUTOFILL_CHARS) return false
  const spamFields: ReadonlySet<string> = new Set(SPAM_FIELDS)
  const values = Object.entries(fields)
    .filter(([key]) => !spamFields.has(key))
    .flatMap(([, value]) => stringsOf(value))

  // A name split over several fields ("Bo" + "Ek" = "Bo Ek"): every honeypot word is a whole field.
  const allWords = raw.split(/\s+/).map(normalise).filter(Boolean)
  const whole = new Set(values.map(normalise))
  if (allWords.length > 1 && allWords.every((w) => whole.has(w))) return true

  // Each word on its own too, so "Anna Svensson" matches "Anna S." and "A. Svensson".
  const hpWords = allWords.filter((w) => w.length >= MIN_AUTOFILL_CHARS)
  const hpPhones = phoneNumbers(raw)
  return values.some((s) => {
    if (hpPhones.length) {
      if (phoneNumbers(s).some((p) => hpPhones.some((h) => samePhone(h, p)))) return true
      // Two numbers in one field ("070-… / 08-…") run together into one: look inside its digits.
      const digits = s.replace(/\D/g, '')
      if (hpPhones.some((h) => h.length >= MIN_PHONE_SUFFIX_DIGITS && digits.includes(h))) return true
    }
    const v = normalise(s)
    if (v.length < MIN_AUTOFILL_CHARS) return false
    const short = v.length <= SHORT_VALUE_CHARS && s.trim().split(/\s+/).length <= SHORT_VALUE_WORDS
    if (short) return v.includes(hp) || hp.includes(v) || hpWords.some((w) => v.includes(w))
    return hp.length >= MIN_IN_LONG_TEXT_CHARS && v.includes(hp)
  })
}

/** The shape of a honeypot value for the log, never the value: an e-mail, phone, words or one token. */
function honeypotShape(value: string): { kind: string; len: number } {
  const v = value.trim()
  const kind = v.includes('@')
    ? 'email'
    : /^\+?\d[\d\s().\-/]*$/.test(v) && phoneNumbers(v).length
      ? 'phone'
      : /\s/.test(v)
        ? 'words'
        : 'token'
  return { kind, len: v.length }
}

// ---- sender blocklist ----

type Block = { emails: Set<string>; domains: string[]; phones: string[] }

const EMAIL = /[^\s@<>()[\]{},;:"']+@[^\s@<>()[\]{},;:"']+\.[^\s@<>()[\]{},;:"']+/g
const DOMAIN = /^[\p{L}\p{N}-]+(\.[\p{L}\p{N}-]+)+$/u

/**
 * Parse blocklist entries: `email:a@b.se` (exact), `email:@b.se` (the domain and its subdomains),
 * `phone:+46 70 …` (any national or international form). Entries are separated by commas,
 * semicolons or line breaks (a phone number has spaces). Bad entries are skipped and named by
 * position, never by value.
 */
function parseBlock(entries: string[], source: string): Block {
  const block: Block = { emails: new Set(), domains: [], phones: [] }
  const skipped: number[] = []
  entries.forEach((raw, i) => {
    const colon = raw.indexOf(':')
    const kind = raw.slice(0, colon).trim().toLowerCase()
    const value = raw.slice(colon + 1).trim().normalize('NFKC').toLowerCase()
    if (colon > 0 && kind === 'email' && value.startsWith('@') && DOMAIN.test(value.slice(1))) {
      block.domains.push(value.slice(1))
    } else if (colon > 0 && kind === 'email' && (value.match(EMAIL) ?? [])[0] === value) {
      block.emails.add(value)
    } else if (colon > 0 && kind === 'phone' && phoneNumbers(value).length === 1) {
      block.phones.push(phoneNumbers(value)[0] ?? '')
    } else {
      skipped.push(i + 1)
    }
  })
  if (skipped.length) {
    warnOnce(`[spam-guard] ${source}: skipped entries ${skipped.join(', ')} (use email:address, email:@domain or phone:number)`)
  }
  return block
}

function splitEntries(value: string | undefined): string[] {
  return (value ?? '').split(/[,;\n]+/).map((e) => e.trim()).filter(Boolean)
}

/** The blocklist entry a post matches, as its kind for the log, or null. */
function blockedKind(fields: Record<string, unknown>, messageFields: string[], extra: string[] = []): string | null {
  const fromEnv = parseBlock(splitEntries(env('SPAM_BLOCK')), 'SPAM_BLOCK')
  const fromCode = parseBlock(extra.flatMap((e) => splitEntries(e)), 'checkSubmission block')
  const emails = new Set([...fromEnv.emails, ...fromCode.emails])
  const domains = [...fromEnv.domains, ...fromCode.domains]
  const phones = [...fromEnv.phones, ...fromCode.phones]
  if (!emails.size && !domains.length && !phones.length) return null

  const skip: ReadonlySet<string> = new Set([...SPAM_FIELDS, ...messageFields])
  const values = Object.entries(fields)
    .filter(([key]) => !skip.has(key))
    .flatMap(([, value]) => stringsOf(value))
    .filter((s) => s.length <= MAX_AUTOFILL_CHARS) // a sender's address or number is never longer
  for (const s of values) {
    for (const address of s.normalize('NFKC').toLowerCase().match(EMAIL) ?? []) {
      if (emails.has(address)) return 'email'
      const domain = address.slice(address.lastIndexOf('@') + 1)
      if (domains.some((d) => domain === d || domain.endsWith('.' + d))) return 'domain'
    }
    // The post's number may carry more in front (a foreign country code), never less: "123 45 67"
    // alone is not the blocked "08-123 45 67".
    const has = (p: string, b: string) => p === b || (b.length >= MIN_PHONE_SUFFIX_DIGITS && p.endsWith(b))
    if (phones.length && phoneNumbers(s).some((p) => phones.some((b) => has(p, b)))) return 'phone'
  }
  return null
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
  const messageFields = options.messageFields ?? ['message']

  // 1. Honeypot. Without a token it is a bot. With one it is usually a password
  //    manager's autofill (1Password and LastPass ignore autocomplete="off"), so the
  //    provider decides in step 4: verified → sent and flagged, else the fake success.
  const honeypot = hasText(f[HONEYPOT_FIELD])
  if (honeypot && !hasText(f[RECAPTCHA_TOKEN_FIELD]) && !hasText(f[ALTCHA_FIELD])) {
    log('honeypot', { token: 'no' })
    return { reason: 'honeypot' }
  }

  // 2. Configuration.
  const p = provider()
  const missing = (await missingConfig()) ?? (p === 'altcha' && !request ? 'request not passed' : null)
  if (missing || !p) {
    if (import.meta.env.DEV) {
      if (honeypot) {
        log('honeypot', { token: 'yes' })
        return { reason: 'honeypot' }
      }
      console.warn(`[spam-guard] ${missing} — only the honeypot is active (dev only)`)
      return { reason: 'ok' }
    }
    console.error(`[spam-guard] ${missing} — rejecting submission`)
    return { reason: 'misconfigured' }
  }

  // 3. Rate limit: look only.
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
    if (honeypot) {
      log('honeypot', { token: 'yes' })
      return { reason: 'honeypot' }
    }
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
  // Sender blocklist: before the honeypot verdict, so a blocked sender's autofill can't send it.
  const blocked = blockedKind(f, messageFields, options.block)
  if (blocked) {
    log('blocked', { kind: blocked, provider: p })
    return { reason: 'honeypot' }
  }
  if (honeypot) {
    if (!looksAutofilled(f)) {
      log('honeypot', { token: 'yes', match: 'no', ...honeypotShape(String(f[HONEYPOT_FIELD])), provider: p })
      return { reason: 'honeypot' }
    }
    log('honeypot-overridden', { provider: p })
    return { reason: 'ok', flag: 'honeypot' }
  }
  const flag = request ? contentFlag(f, messageFields) : undefined

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
