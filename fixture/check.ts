// Proves the packed package works in a real Astro site: npm pack → install the tarball
// into a copy of fixture/site with the given Astro version → build → assert → start →
// GET the routes → post test (stubbed Resend) → astro dev serves the client.
//
// Usage: npm run test:fixture -- <astro version> <@astrojs/node version> [--port N] [--keep]
//   --keep   leave the built site in fixture/.work/astro-<version> (for a manual post test)
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { request } from 'node:http'
import { fileURLToPath } from 'node:url'
import { solveChallenge } from 'altcha-lib'
import { deriveKey } from 'altcha-lib/algorithms/pbkdf2'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = '@visionmediahq/spam-guard'
const FORBIDDEN_SCRIPTS = ['prepare', 'preinstall', 'install', 'postinstall', 'prepack', 'build']

// Dummy values written to the fixture's .env before the build. None may reach dist/server.
const DUMMY = {
  RESEND_API_KEY: 're_fixture_dummy_key_7Hq2',
  ALTCHA_HMAC_SECRET: 'f1x7ure'.repeat(10),
  CONTACT_TO: 'to-fixture-dummy@fixture.example',
}

const args = process.argv.slice(2)
const keep = args.includes('--keep')
const portIndex = args.indexOf('--port')
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 5600
const [astroVersion, adapterVersion] = args.filter((a, i) => !a.startsWith('--') && (portIndex < 0 || i !== portIndex + 1))
if (!astroVersion || !adapterVersion) {
  console.error('usage: npm run test:fixture -- <astro version> <@astrojs/node version> [--port N] [--keep]')
  process.exit(2)
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`fixture: ${message}`)
}

function run(command: string, cmdArgs: string[], cwd: string): void {
  const result = spawnSync(command, cmdArgs, { cwd, stdio: 'inherit', env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' } })
  assert(result.status === 0, `\`${command} ${cmdArgs.join(' ')}\` failed with exit code ${result.status}`)
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

async function waitFor(url: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(url)
      return
    } catch {
      await new Promise((r) => setTimeout(r, 200))
    }
  }
  throw new Error(`fixture: server did not answer at ${url}`)
}

/** A solved `altcha` field value, fetched from the running site and solved like the browser does. */
async function solved(base: string, xff: string): Promise<string> {
  const res = await fetch(`${base}/api/altcha-challenge`, { headers: { 'x-forwarded-for': xff } })
  assert(res.ok, `challenge: ${res.status}`)
  const challenge = await res.json()
  const solution = await solveChallenge({ challenge, deriveKey })
  assert(solution, 'challenge could not be solved')
  return btoa(JSON.stringify({ challenge: { parameters: challenge.parameters, signature: challenge.signature }, solution }))
}

/** End to end through the site's own contact route: guard, rate limit, no-JS reply, stubbed send. */
async function postTest(base: string, stubLog: string): Promise<void> {
  const fields = { name: 'Test', email: 'test@fixture.example', message: 'Hej, ett test.' }
  const post = (xff: string, extra: Record<string, string>) =>
    fetch(`${base}/api/contact`, {
      method: 'POST',
      headers: { 'x-forwarded-for': xff, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, ...extra }),
    })
  const sends = () => (existsSync(stubLog) ? readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).length : 0)

  const nosol = await post('10.1.0.1', {})
  assert(nosol.status === 400, `no solution: ${nosol.status}, want 400`)
  const honeypot = await post('10.2.0.1', { hp_x7q2: 'x' })
  assert(honeypot.status === 200 && (await honeypot.json()).success === true, `honeypot: ${honeypot.status}, want a fake 200`)
  assert(sends() === 0, 'a rejected or honeypot post was sent')

  const codes: number[] = []
  for (let i = 0; i < 6; i++) codes.push((await post('10.3.0.1', { altcha: await solved(base, '10.9.0.1') })).status)
  assert(codes.join(' ') === '200 200 200 200 200 429', `solved posts from one client: ${codes.join(' ')}, want 5 × 200 then 429`)
  assert(sends() === 5, `${sends()} sends, want 5`)

  // fetch() always sends its own Sec-Fetch-Mode, so the browser's native form post goes through node:http.
  const noJs = await new Promise<{ status: number; location: string | undefined }>((resolve, reject) => {
    const body = new URLSearchParams({ ...fields, form_return: '/kontakt/' }).toString()
    const req = request(`${base}/api/contact`, {
      method: 'POST',
      headers: { 'x-forwarded-for': '10.4.0.1', 'Content-Type': 'application/x-www-form-urlencoded', 'Sec-Fetch-Mode': 'navigate' },
    }, (res) => {
      res.resume()
      resolve({ status: res.statusCode ?? 0, location: res.headers.location })
    })
    req.on('error', reject)
    req.end(body)
  })
  assert(noJs.status === 303 && noJs.location === '/kontakt/#fel', `no-JS post: ${noJs.status} ${noJs.location}, want 303 /kontakt/#fel`)
  console.log('post test: nosol=400 honeypot=200(fake) solved=200×5 6th=429 no-js=303 #fel sends=5')
}

/** SIGTERM a detached process group, SIGKILL whatever is left after 5 s. */
async function stopGroup(pid: number | undefined): Promise<void> {
  if (!pid) return
  const alive = () => {
    try {
      process.kill(-pid, 0)
      return true
    } catch {
      return false
    }
  }
  if (alive()) process.kill(-pid, 'SIGTERM')
  for (let i = 0; i < 25 && alive(); i++) await new Promise((r) => setTimeout(r, 200))
  if (alive()) process.kill(-pid, 'SIGKILL')
}

const work = join(ROOT, 'fixture/.work')
const dir = join(work, `astro-${astroVersion}`)
let tarball = ''

try {
  mkdirSync(work, { recursive: true })
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: ROOT, encoding: 'utf8' }))
  tarball = join(work, packed[0].filename)

  rmSync(dir, { recursive: true, force: true })
  cpSync(join(ROOT, 'fixture/site'), dir, { recursive: true })
  writeFileSync(join(dir, '.env'), Object.entries(DUMMY).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')

  // Without a lockfile npm may hoist a Vite a major ahead of the one this Astro runs on.
  const viteRange = execFileSync('npm', ['view', `astro@${astroVersion}`, 'dependencies.vite'], { encoding: 'utf8' }).trim()
  assert(viteRange, `could not read the vite range of astro@${astroVersion}`)
  run('npm', ['pkg', 'set',
    `dependencies.${PKG}=file:${tarball}`,
    `dependencies.astro=${astroVersion}`,
    `dependencies.@astrojs/node=${adapterVersion}`,
    `dependencies.vite=${viteRange}`,
  ], dir)
  run('npm', ['install', '--no-audit', '--no-fund'], dir)

  // The installed package: a real directory with src only, no lifecycle scripts.
  const installed = join(dir, 'node_modules', PKG)
  assert(!lstatSync(installed).isSymbolicLink(), 'the package must be a real directory, not a symlink')
  assert(existsSync(join(installed, 'src/routes/form-config.ts')), 'installed package lacks src/')
  for (const extra of ['test', 'fixture', '.github']) assert(!existsSync(join(installed, extra)), `installed package contains ${extra}/`)
  const installedPkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'))
  for (const name of FORBIDDEN_SCRIPTS) assert(!(name in (installedPkg.scripts ?? {})), `package.json has a "${name}" script`)
  assert(!('workspaces' in installedPkg), 'package.json has workspaces')
  const installedAstro = JSON.parse(readFileSync(join(dir, 'node_modules/astro/package.json'), 'utf8')).version
  assert(installedAstro === astroVersion, `expected astro ${astroVersion}, got ${installedAstro}`)

  run('npx', ['astro', 'build'], dir)

  // The ALTCHA solver's worker is emitted next to the client bundle.
  const assets = readdirSync(join(dir, 'dist/client/_astro'))
  assert(assets.some((f) => /pbkdf2.*\.js$/.test(f)), `no pbkdf2 worker in dist/client/_astro (${assets.join(', ')})`)

  // import.meta.env.DEV resolved: no dev-only env code or build-time values in the server bundle.
  const server = filesUnder(join(dir, 'dist/server')).filter((f) => /\.(m?js|json)$/.test(f))
  const serverText = server.map((f) => readFileSync(f, 'utf8')).join('\n')
  assert(!serverText.includes('devEnv'), 'dist/server contains devEnv')
  for (const [key, value] of Object.entries(DUMMY)) {
    assert(!serverText.includes(value), `dist/server contains the build-time value of ${key}`)
  }

  // The @source line works: classes used only inside the package's components are in the CSS.
  const css = assets.filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(dir, 'dist/client/_astro', f), 'utf8')).join('\n')
  for (const cls of ['.target\\:grid', '.alert-success', '.-left-\\[9999px\\]', '.scroll-mt-40']) {
    assert(css.includes(cls), `built CSS lacks ${cls}`)
  }

  // The components render, in both languages.
  const sv = readFileSync(join(dir, 'dist/client/index.html'), 'utf8')
  const en = readFileSync(join(dir, 'dist/client/en/index.html'), 'utf8')
  assert(sv.includes('Formuläret kräver JavaScript') && sv.includes('name="hp_x7q2"') && sv.includes('id="fel"'), 'sv page lacks the components')
  assert(en.includes('This form needs JavaScript. Call us on') && en.includes('Your message was not sent.'), 'en page lacks the English texts')
  assert(!en.includes('Formuläret kräver'), 'en page has the Swedish notice')
  // Astro 7 drops a line break between text and a link: the space must be explicit.
  assert(sv.includes('eller ring oss på <a') && en.includes('or call us on <a'), 'wait message: no space before the phone link')
  // v1.1: no phone number, and the site's own wording for some parts.
  const mail = readFileSync(join(dir, 'dist/client/mejl/index.html'), 'utf8').replace(/\s+/g, ' ')
  assert(mail.includes('Formuläret kräver JavaScript. Mejla oss i stället på <a href="mailto:info@fixture.example">'), 'mejl page: notice without a phone')
  assert(mail.includes('Tack! Jag hör av mig så snart jag kan.'), 'mejl page: own sent text')
  assert(mail.includes('Meddelandet skickades inte. Mejla oss i stället på <a class="link font-semibold" href="mailto:info@fixture.example"'), 'mejl page: error without a phone')
  assert(mail.includes('Vänta en stund, eller mejla oss på <a class="link font-semibold" href="mailto:info@fixture.example"'), 'mejl page: wait without a phone')
  assert(!mail.includes('tel:'), 'mejl page links a phone number')
  // 1.2: neither a phone number nor an e-mail address.
  const none = readFileSync(join(dir, 'dist/client/ingen/index.html'), 'utf8').replace(/\s+/g, ' ')
  assert(none.includes('This form needs JavaScript. Please turn it on to send us a message.'), 'ingen page: notice without contact details')
  assert(none.includes('Your message was not sent. This form needs JavaScript: please turn it on and try again.'), 'ingen page: error without contact details')
  assert(none.includes('You have sent several messages in a short time. Please wait a while and try again.'), 'ingen page: wait without contact details')
  assert(!none.includes('tel:') && !none.includes('mailto:'), 'ingen page links a phone number or address')

  // The re-exported routes answer at runtime, with the settings from the runtime environment only.
  // Resend is stubbed (resend-stub.ts): nothing leaves the machine.
  const stubLog = join(work, `sent-${astroVersion}.log`)
  rmSync(stubLog, { force: true })
  const child = spawn(process.execPath, ['--experimental-strip-types', '--import', join(ROOT, 'fixture/resend-stub.ts'), 'dist/server/entry.mjs'], {
    cwd: dir,
    env: {
      PATH: process.env.PATH,
      HOST: '127.0.0.1',
      PORT: String(port),
      SPAM_PROVIDER: 'altcha',
      ALTCHA_HMAC_SECRET: 'r'.repeat(64),
      RESEND_API_KEY: 're_stub',
      CONTACT_TO: 'to@fixture.example',
      CONTACT_FROM: 'from@fixture.example',
      STUB_LOG: stubLog,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  try {
    const base = `http://127.0.0.1:${port}`
    await waitFor(`${base}/api/form-config`)
    const cfg = await fetch(`${base}/api/form-config`)
    const cfgBody = await cfg.json()
    assert(cfg.status === 200 && cfgBody.provider === 'altcha', `form-config: ${cfg.status} ${JSON.stringify(cfgBody)}`)
    const ch = await fetch(`${base}/api/altcha-challenge`, { headers: { 'x-forwarded-for': '10.0.0.1' } })
    const chBody = await ch.json()
    assert(ch.status === 200 && typeof chBody.parameters?.nonce === 'string', `altcha-challenge: ${ch.status}`)
    await postTest(base, stubLog)
  } finally {
    child.kill()
    await new Promise((r) => child.once('exit', r))
  }

  // astro dev serves the form script, the package's client and altcha's worker.
  const astroBin = join(dir, 'node_modules/astro/bin/astro.mjs')
  const dev = spawn(process.execPath, [astroBin, 'dev', '--port', String(port + 1), '--host', '127.0.0.1'], {
    cwd: dir,
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
    stdio: ['ignore', 'ignore', 'inherit'],
    detached: true, // own process group: Astro 7's dev server runs in a child process
  })
  try {
    const base = `http://127.0.0.1:${port + 1}`
    await waitFor(base)
    const page = await (await fetch(`${base}/`)).text()
    const script = page.match(/src="([^"]*index\.astro\?astro&type=script[^"]*)"/)?.[1]
    assert(script, 'dev: no form script on /')
    const scriptCode = await (await fetch(base + script.replaceAll('&amp;', '&'))).text()
    const client = scriptCode.match(/"(\/[^"]*spam-guard[^"]*)"/)?.[1]
    assert(client, 'dev: the form script does not import the package client')
    const clientRes = await fetch(base + client)
    assert(clientRes.status === 200, `dev: the package client answers ${clientRes.status}`)
    const worker = (await clientRes.text()).match(/"(\/[^"]*pbkdf2[^"]*)"/)?.[1]
    assert(worker && (await fetch(base + worker)).status === 200, 'dev: the pbkdf2 worker URL does not load')
  } finally {
    // Astro 7 moves `astro dev` to a background process when it detects an AI agent.
    if (Number(astroVersion.split('.')[0]) >= 7) spawnSync(process.execPath, [astroBin, 'dev', 'stop'], { cwd: dir, stdio: 'ignore' })
    await stopGroup(dev.pid)
  }

  console.log(`✓ fixture astro@${astroVersion} @astrojs/node@${adapterVersion}`)
  if (keep) console.log(`kept: ${dir}`)
} catch (error) {
  console.error(`✗ ${(error as Error).message}`)
  process.exitCode = 1
} finally {
  if (tarball) rmSync(tarball, { force: true })
  rmSync(join(work, `sent-${astroVersion}.log`), { force: true })
  if (!keep) rmSync(dir, { recursive: true, force: true })
}
