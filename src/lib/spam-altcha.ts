// ALTCHA proof-of-work for the spam guard (provider 'altcha') — self-hosted,
// no third party, no cookies.
//
// The server signs a challenge (HMAC with ALTCHA_HMAC_SECRET), the browser finds
// the counter by brute force (spam-client.ts), and verification checks the
// signature, the expiry and the derived key. The challenge carries a key
// signature, so verifying needs no key derivation — rejecting junk is cheap.
// Each challenge nonce is accepted once (in-memory replay store).

import { createChallenge, randomInt, verifySolution } from 'altcha-lib'
import type { Challenge } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2'
import { deriveHmacKeySecret } from 'altcha-lib/frameworks/shared'
import { env } from './runtime-env'
import type { Verdict } from './spam-recaptcha'

const TTL_MS = 2 * 60 * 60_000
const ALGORITHM = 'PBKDF2/SHA-256'
const MIN_SECRET_CHARS = 32

// Difficulty measured 2026-10-03 (Gate A): Mac WebKit with one worker solves in
// ~0.75 s median / 1.05 s worst, four workers in ~0.2–0.3 s. Target: 0.5–1 s on a
// mid-range phone. Approved 2026-10-04; re-check on a real mid-range phone.
let cost = 5000
let counterMin = 500
let counterMax = 1500
let maxUsed = 50_000

type Secrets = { sig: string; keySig: string }

let cached: Promise<Secrets | null> | null = null

/** The signing secrets, derived once per process. Null when the secret is missing or too short. */
function secrets(): Promise<Secrets | null> {
  cached ??= (async () => {
    const sig = env('ALTCHA_HMAC_SECRET')
    if (!sig || sig.length < MIN_SECRET_CHARS) return null
    return { sig, keySig: await deriveHmacKeySecret(sig) }
  })()
  return cached
}

export async function altchaConfigured(): Promise<boolean> {
  return (await secrets()) !== null
}

/** A new signed challenge. Call only when altchaConfigured() is true. */
export async function createAltchaChallenge(): Promise<Challenge> {
  const s = await secrets()
  if (!s) throw new Error('[spam-guard] ALTCHA_HMAC_SECRET not set')
  return createChallenge({
    algorithm: ALGORITHM,
    cost,
    counter: randomInt(counterMax, counterMin),
    deriveKey,
    expiresAt: new Date(Date.now() + TTL_MS),
    data: { iat: Date.now() }, // signed issue time (ms), logged as age_s
    hmacSignatureSecret: s.sig,
    hmacKeySignatureSecret: s.keySig,
  })
}

/** Nonce → expiresAt (seconds). Bounded; never evicts, since eviction would re-open replays. */
const used = new Map<string, number>()

function rejected(detail: string): Verdict {
  return { status: 'rejected', detail }
}

function isString(v: unknown): v is string {
  return typeof v === 'string'
}

/** Verify the `altcha` field of a submission. */
export async function verifyAltcha(raw: unknown): Promise<Verdict> {
  if (raw == null || raw === '') return rejected('missing') // no-JS posts land here
  if (!isString(raw)) return rejected('unparseable')

  let payload: any
  try {
    payload = JSON.parse(atob(raw))
  } catch {
    return rejected('unparseable')
  }
  if (
    !isString(payload?.challenge?.parameters?.nonce) ||
    !isString(payload?.challenge?.signature) ||
    !isString(payload?.solution?.derivedKey)
  ) {
    return rejected('unparseable')
  }

  const s = await secrets()
  if (!s) return { status: 'misconfigured', detail: 'ALTCHA_HMAC_SECRET' }

  let result: Awaited<ReturnType<typeof verifySolution>>
  try {
    result = await verifySolution({
      challenge: payload.challenge,
      solution: payload.solution,
      deriveKey,
      hmacSignatureSecret: s.sig,
      hmacKeySignatureSecret: s.keySig,
    })
  } catch {
    return rejected('unparseable')
  }
  // verifySolution checks expiry before the signature: a forged payload with an
  // old expiresAt is reported as expired.
  if (result.expired) return rejected('expired')
  if (!result.verified) return rejected('invalid')

  const nowS = Math.floor(Date.now() / 1000)
  for (const [nonce, expiresAt] of used) {
    if (expiresAt < nowS) used.delete(nonce)
  }
  const nonce: string = payload.challenge.parameters.nonce
  if (used.has(nonce)) return rejected('replayed')
  if (used.size >= maxUsed) {
    console.error('[spam-guard] ALTCHA replay store full — rejecting')
    return rejected('replay-store-full')
  }
  const expiresAt = payload.challenge.parameters.expiresAt
  used.set(nonce, typeof expiresAt === 'number' ? expiresAt : nowS + TTL_MS / 1000)

  const iat = payload.challenge.parameters.data?.iat
  return { status: 'ok', ageS: typeof iat === 'number' ? Math.round((Date.now() - iat) / 1000) : undefined }
}

/** Test hook: lower the difficulty or the replay store size. */
export function _configureForTests(opts: {
  cost?: number
  counterMin?: number
  counterMax?: number
  maxUsed?: number
}): void {
  cost = opts.cost ?? cost
  counterMin = opts.counterMin ?? counterMin
  counterMax = opts.counterMax ?? counterMax
  maxUsed = opts.maxUsed ?? maxUsed
}
