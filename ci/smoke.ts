// GET checks against a running astro-starter wired to this package (npm start or the Docker image),
// started with SPAM_PROVIDER=altcha and an ALTCHA_HMAC_SECRET. Repo tool; not shipped.
//
// Usage: node --experimental-strip-types ci/smoke.ts <base url>
export {}

const base = process.argv[2]?.replace(/\/$/, '')
if (!base) {
  console.error('usage: node --experimental-strip-types ci/smoke.ts <base url>')
  process.exit(2)
}

const HEADERS = [
  ['x-frame-options', 'DENY'],
  ['x-content-type-options', 'nosniff'],
  ['referrer-policy', 'strict-origin-when-cross-origin'],
  ['permissions-policy', 'camera=(), microphone=(), geolocation=()'],
  ['x-xss-protection', '1; mode=block'],
] as const

const failures: string[] = []
const results: string[] = []
function check(name: string, ok: boolean, detail: string): void {
  results.push(`${name}=${ok ? 'ok' : `FAIL(${detail})`}`)
  if (!ok) failures.push(name)
}

for (let i = 0; i < 60; i++) {
  try {
    await fetch(`${base}/`)
    break
  } catch {
    await new Promise((r) => setTimeout(r, 500))
  }
}

const cfg = await fetch(`${base}/api/form-config`)
const cfgBody = await cfg.json().catch(() => null)
check('form-config', cfg.status === 200 && cfgBody?.provider === 'altcha', `${cfg.status} ${JSON.stringify(cfgBody)}`)

const ch = await fetch(`${base}/api/altcha-challenge`, { headers: { 'x-forwarded-for': '10.0.0.1' } })
const chBody = await ch.json().catch(() => null)
check('altcha-challenge', ch.status === 200 && typeof chBody?.parameters?.nonce === 'string', String(ch.status))

for (const path of ['/', '/api/form-config', '/finns-inte']) {
  const res = await fetch(`${base}${path}`)
  const missing = HEADERS.filter(([name, value]) => res.headers.get(name) !== value).map(([name]) => name)
  check(`headers${path}`, missing.length === 0, `missing ${missing.join(',')}`)
}

console.log(results.join(' '))
if (failures.length) process.exit(1)
