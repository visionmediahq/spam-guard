import type { APIRoute } from 'astro'
import { altchaConfigured, createAltchaChallenge } from '../../lib/spam-altcha'
import { CLIENT_FAIL_REASONS } from '../../lib/spam-fields'
import { clientIp, ipKey, log, provider } from '../../lib/spam-guard'
import { challengeGlobal, challengeLimiter } from '../../lib/spam-ratelimit'

// GET /api/altcha-challenge — a fresh signed ALTCHA challenge for the browser
// to solve (spam-client.ts). Rate-limited per client and for the whole site,
// since creating a challenge costs one key derivation.
//
// GET /api/altcha-challenge?fail=<reason> — the browser reports that it could
// not produce a solution. Logged as one `client-fail` line; only the fixed
// reasons in CLIENT_FAIL_REASONS are logged, anything else is dropped.
export const prerender = false

const failReasons: ReadonlySet<string> = new Set(CLIENT_FAIL_REASONS)

function json(body: object, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  })
}

export const GET: APIRoute = async ({ request, url }) => {
  const key = ipKey(clientIp(request))

  const reason = url.searchParams.get('fail')
  if (reason !== null) {
    if (failReasons.has(reason) && challengeLimiter.hit(key) === 0) log('client-fail', { reason })
    return new Response(null, { status: 204 })
  }

  if (provider() !== 'altcha' || !(await altchaConfigured())) {
    return json({ error: 'unavailable' }, 503)
  }
  // Per client first: a request it refuses must not count toward the site-wide cap,
  // or one client could use up the budget and block every visitor.
  const wait = challengeLimiter.hit(key) || challengeGlobal.hit('all')
  if (wait > 0) return json({ error: 'rate-limited' }, 429, { 'Retry-After': String(wait) })

  return json(await createAltchaChallenge(), 200)
}
