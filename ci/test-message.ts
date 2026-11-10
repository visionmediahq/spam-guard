// The standard test message for a client's contact form (#9). Repo tool; not shipped.
//
// It goes through the site's real route, the way a browser does: fetch /api/altcha-challenge,
// solve it (a real proof of work, not a bypass), post the fields with an empty honeypot. So the
// spam check, the rate limit and the mail all run as for a visitor.
//
// Usage:
//   node --experimental-strip-types ci/test-message.ts <site url> [options]     # dry run: shows what it would send
//   node --experimental-strip-types ci/test-message.ts <site url> --send ...    # sends: lands in the client's inbox
//
// Options:
//   --repo <name>        read the spam-guard version from visionmediahq/<name>'s lockfile (needs gh)
//   --version <x.y.z>    the version to show, instead of --repo
//   --phone <number>     add a phone field (only where the form requires one); or TEST_PHONE in the env
//   --path <path>        the form route, default /api/contact
//   --map <site>=<std>   send a standard field under the site's own name, e.g. --map namn=name
//   --field <key>=<val>  an extra field the form requires, e.g. --field antal=20
//   --json               post JSON instead of form data
//   --omit <field>       leave out company, subject or phone (a site whose own old honeypot uses that name)
//
// Each live send needs Jörgen's OK first: the client sees it. One post per run; each post counts
// toward the site's rate limit (5 per client per 10 minutes). Keep phone numbers out of this repo.

import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

export const SUBJECT = 'TEST från Vision Media (kan ignoreras)'
const STANDARD = ['name', 'email', 'company', 'subject', 'message', 'phone'] as const
type Standard = (typeof STANDARD)[number]
/** Fields the test can do without; name, e-mail and message always go. */
const OPTIONAL: readonly Standard[] = ['company', 'subject', 'phone']

/** The message text: fixed wording, then the site host and the spam-guard version that handled it. */
export function testMessage(host: string, version: string | undefined): string {
  return (
    'TEST – inget att åtgärda. Vi har uppdaterat skyddet mot skräppost i kontaktformuläret och ' +
    'kontrollerar att meddelanden kommer fram. Ni behöver inte svara. Hälsningar, Vision Media\n\n' +
    `Sida: ${host} · spam-guard ${version ? `v${version}` : 'version okänd'}`
  )
}

export type FieldOptions = {
  host: string
  version: string | undefined
  phone?: string
  /** site field name → standard field name */
  map?: Record<string, Standard>
  extra?: Record<string, string>
  omit?: Standard[]
}

/** The fields to post, without the altcha payload. */
export function formFields(o: FieldOptions): Record<string, string> {
  const std: Partial<Record<Standard, string>> = {
    name: 'Vision Media (test)',
    email: 'support@visionmedia.io', // the reply-to: a client's reply reaches the shared support inbox
    company: 'Vision Media',
    subject: SUBJECT,
    message: testMessage(o.host, o.version),
    ...(o.phone ? { phone: o.phone } : {}),
  }
  for (const k of o.omit ?? []) delete std[k]
  const renamed = new Set(Object.values(o.map ?? {}))
  const fields: Record<string, string> = {}
  for (const [key, value] of Object.entries(std)) if (!renamed.has(key as Standard)) fields[key] = value
  for (const [site, standard] of Object.entries(o.map ?? {})) {
    const value = std[standard]
    if (value !== undefined) fields[site] = value
  }
  return { ...fields, ...(o.extra ?? {}), hp_x7q2: '' }
}

export type Args = {
  base: string
  path: string
  send: boolean
  json: boolean
  repo?: string
  version?: string
  phone?: string
  map: Record<string, Standard>
  extra: Record<string, string>
  omit: Standard[]
}

const USAGE = 'usage: node --experimental-strip-types ci/test-message.ts <site url> [--send] [--repo name | --version x.y.z] [--phone n] [--path /api/contact] [--map site=standard] [--field key=value] [--omit company|subject|phone] [--json]'

function pair(flag: string, value: string | undefined): [string, string] {
  const i = value?.indexOf('=') ?? -1
  if (!value || i < 1) throw new Error(`${flag} needs key=value`)
  return [value.slice(0, i), value.slice(i + 1)]
}

export function parseArgs(argv: string[], envVars: Record<string, string | undefined>): Args {
  const [url, ...rest] = argv
  if (!url) throw new Error(USAGE)
  if (!/^https?:\/\//.test(url)) throw new Error(`the site url must start with http:// or https:// (${USAGE})`)
  const a: Args = { base: url.replace(/\/+$/, ''), path: '/api/contact', send: false, json: false, map: {}, extra: {}, omit: [] }
  const phone = envVars.TEST_PHONE?.trim()
  if (phone) a.phone = phone
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]
    const next = () => {
      const v = rest[++i]
      if (v === undefined) throw new Error(`${flag} needs a value`)
      return v
    }
    if (flag === '--send') a.send = true
    else if (flag === '--json') a.json = true
    else if (flag === '--repo') a.repo = next()
    else if (flag === '--version') a.version = next()
    else if (flag === '--phone') a.phone = next()
    else if (flag === '--path') a.path = next()
    else if (flag === '--map') {
      const [site, standard] = pair(flag, next())
      if (!(STANDARD as readonly string[]).includes(standard)) throw new Error(`--map: ${standard} is not one of ${STANDARD.join(', ')}`)
      a.map[site] = standard as Standard
    } else if (flag === '--field') {
      const [key, value] = pair(flag, next())
      a.extra[key] = value
    } else if (flag === '--omit') {
      const field = next()
      if (!(OPTIONAL as readonly string[]).includes(field)) throw new Error(`--omit: ${field} is not one of ${OPTIONAL.join(', ')}`)
      a.omit.push(field as Standard)
    } else throw new Error(`unknown option ${flag} (${USAGE})`)
  }
  return a
}

/**
 * Fields this post sends that the site's own route reads as a honeypot (an older copy, like lovit's
 * `company`): such a post is dropped with a fake success, so the test would look delivered.
 */
export function ownHoneypotFields(routeSource: string, sent: string[]): string[] {
  const lines = routeSource.split('\n').filter((l) => /honeypot/i.test(l))
  return sent.filter((f) => f !== 'hp_x7q2' && lines.some((l) => new RegExp(`['"\`.]${f}\\b`).test(l)))
}

function routeSource(repo: string, path: string): string | undefined {
  for (const ext of ['ts', 'js', 'mjs']) {
    try {
      const b64 = execFileSync('gh', ['api', `repos/visionmediahq/${repo}/contents/src/pages${path}.${ext}`, '--jq', '.content'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      return Buffer.from(b64, 'base64').toString('utf8')
    } catch {
      // try the next extension
    }
  }
  return undefined
}

/** The spam-guard version locked in visionmediahq/<repo>'s default branch. */
function lockedVersion(repo: string): string | undefined {
  const b64 = execFileSync('gh', ['api', `repos/visionmediahq/${repo}/contents/package-lock.json`, '--jq', '.content'], { encoding: 'utf8' })
  const lock = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as { packages?: Record<string, { version?: string }> }
  return lock.packages?.['node_modules/@visionmediahq/spam-guard']?.version
}

async function main(): Promise<void> {
  let args: Args
  try {
    args = parseArgs(process.argv.slice(2), process.env)
  } catch (e) {
    console.error((e as Error).message)
    process.exit(2)
  }
  const host = new URL(args.base).host
  const version = args.version ?? (args.repo ? lockedVersion(args.repo) : undefined)

  const config = (await (await fetch(`${args.base}/api/form-config`)).json()) as { provider?: string }
  if (config.provider !== 'altcha') {
    console.error(`${host}: /api/form-config says provider=${config.provider}; this script only solves ALTCHA`)
    process.exit(1)
  }

  const fields = formFields({ host, version, phone: args.phone, map: args.map, extra: args.extra, omit: args.omit })
  const src = args.repo ? routeSource(args.repo, args.path) : undefined
  const trap = src ? ownHoneypotFields(src, Object.keys(fields)) : []
  if (trap.length) {
    console.error(`${host}: the route reads ${trap.join(', ')} as its own honeypot; the post would be dropped with a fake success. Leave it out with --omit or rename it with --map.`)
    process.exit(1)
  }
  console.log(`${args.send ? 'Sending' : 'Dry run (add --send to send)'}: POST ${args.base}${args.path}${args.json ? ' (JSON)' : ''}`)
  for (const [k, v] of Object.entries(fields)) console.log(`  ${k}: ${v.replace(/\n/g, ' ⏎ ')}`)
  if (!args.send) return

  const { solveChallenge } = await import('altcha-lib')
  const { deriveKey } = await import('altcha-lib/algorithms/pbkdf2')
  const res = await fetch(`${args.base}/api/altcha-challenge`)
  if (!res.ok) throw new Error(`challenge: HTTP ${res.status}`)
  const challenge = await res.json()
  const solution = await solveChallenge({ challenge, deriveKey })
  if (!solution) throw new Error('the challenge could not be solved')
  const altcha = btoa(JSON.stringify({ challenge: { parameters: challenge.parameters, signature: challenge.signature }, solution }))

  const headers: Record<string, string> = { Accept: 'application/json', 'Sec-Fetch-Mode': 'cors', Origin: new URL(args.base).origin }
  let body: FormData | string
  if (args.json) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify({ ...fields, altcha })
  } else {
    body = new FormData()
    for (const [k, v] of Object.entries({ ...fields, altcha })) body.append(k, v)
  }
  const post = await fetch(`${args.base}${args.path}`, { method: 'POST', headers, body })
  console.log(`HTTP ${post.status} ${await post.text()}`)
  console.log('Then check the site log for "[spam-guard] accepted" and no mail error, and Resend for "delivered".')
  if (!post.ok) process.exit(1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main()
