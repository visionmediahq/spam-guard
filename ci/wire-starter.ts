// Moves an astro-starter checkout (or a site with the starter's copy of the spam guard)
// from the copied files to this package. Repo tool for CI and the migration; not shipped.
//
// Usage: node --experimental-strip-types ci/wire-starter.ts <site dir> [dependency spec]
//   dependency spec defaults to github:visionmediahq/spam-guard#semver:^1.0.0
//
// Edits (the spec's "SITE AFTER INSTALL"):
//   package.json        add the package, remove altcha / altcha-lib (the package owns them)
//   astro.config.*      vite.optimizeDeps.exclude the package (astro dev; see README)
//   src/styles/*.css    @source the package (Tailwind 4 skips node_modules)
//   src/pages/api/form-config.ts, altcha-challenge.ts   → re-exports + prerender = false
//   every other src file: imports of the copies → package entry points
//   deletes the copies and the tests that moved into the package
// Does not touch package-lock.json: afterwards run `npx npm@10 install --package-lock-only` (the
// Docker images' npm; a lockfile from npm 11 can fail their `npm ci` on altcha-lib's optional peers).
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'

const PKG = '@visionmediahq/spam-guard'
const SOURCE_LINE = `@source "../../node_modules/${PKG}/src";`

/** Copied module → package entry point. null: internal, a site must not import it. */
const LIB_ENTRY: Record<string, string | null> = {
  'spam-guard': PKG,
  'spam-client': `${PKG}/client`,
  'recaptcha-client': `${PKG}/recaptcha-client`,
  'form-redirect': `${PKG}/form-redirect`,
  'runtime-env': `${PKG}/env`,
  phone: `${PKG}/phone`,
  'spam-fields': `${PKG}/fields`,
  'spam-altcha': null,
  'spam-recaptcha': null,
  'spam-ratelimit': null,
  'spam-content': null,
}
const COMPONENTS = ['SpamNotice', 'FormStatus', 'HoneypotField']
const MOVED_TESTS = [
  'spam-altcha', 'spam-client', 'spam-content', 'spam-guard', 'spam-ratelimit', 'spam-recaptcha',
  'form-redirect', 'spam-endpoints',
].map((name) => `src/lib/${name}.test.ts`)

const ROUTES: Record<string, string> = {
  'src/pages/api/form-config.ts': `export { GET } from '${PKG}/routes/form-config'\nexport const prerender = false\n`,
  'src/pages/api/altcha-challenge.ts': `export { GET } from '${PKG}/routes/altcha-challenge'\nexport const prerender = false\n`,
}

function fail(message: string): never {
  throw new Error(`wire-starter: ${message}`)
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? filesUnder(path) : [path]
  })
}

/** Rewrites relative imports of the copied modules and components to the package. */
export function rewriteImports(source: string, file: string): string {
  const lib = /(['"])((?:\.\.?\/)+(?:lib\/)?)(spam-guard|spam-client|recaptcha-client|form-redirect|runtime-env|phone|spam-fields|spam-altcha|spam-recaptcha|spam-ratelimit|spam-content)(?:\.ts)?\1/g
  const out = source.replace(lib, (_match, quote: string, _prefix: string, name: string) => {
    const entry = LIB_ENTRY[name]
    if (!entry) fail(`${file} imports the internal module ${name}; use the package's public entry points`)
    return `${quote}${entry}${quote}`
  })
  const components = new RegExp(`(['"])(?:\\.\\.?/)+(?:components/)?(${COMPONENTS.join('|')})\\.astro\\1`, 'g')
  return out.replace(components, (_match, quote: string, name: string) => `${quote}${PKG}/components/${name}.astro${quote}`)
}

export function wireCss(source: string): string {
  if (source.includes(SOURCE_LINE)) return source
  const plugin = source.match(/^@plugin "daisyui"[^\n]*(\{[\s\S]*?\n\})?[^\n]*\n?/m)
  const anchor = plugin ?? source.match(/^@import "tailwindcss"[^\n]*\n?/m)
  if (!anchor || anchor.index === undefined) fail('no @import "tailwindcss" in the stylesheet')
  const end = anchor.index + anchor[0].length
  const before = source.slice(0, end) + (anchor[0].endsWith('\n') ? '' : '\n')
  return before + SOURCE_LINE + '\n' + source.slice(end)
}

export function wireAstroConfig(source: string): string {
  if (source.includes(`exclude: ['${PKG}']`)) return source
  const plugins = source.match(/^([ \t]*)plugins: \[[^\n]*\],?\n/m)
  if (!plugins || plugins.index === undefined) fail('no vite `plugins: [...]` line in astro.config')
  if (/optimizeDeps/.test(source)) fail('astro.config already has optimizeDeps; add the package to its exclude by hand')
  const indent = plugins[1] ?? ''
  const line = plugins[0].endsWith(',\n') ? plugins[0] : plugins[0].replace(/\n$/, ',\n')
  const insert = `${indent}// astro dev: the spam guard's client imports a worker with \`?url\`, which pre-bundling cannot read.\n${indent}optimizeDeps: { exclude: ['${PKG}'] },\n`
  return source.slice(0, plugins.index) + line + insert + source.slice(plugins.index + plugins[0].length)
}

export function wire(dir: string, spec = `github:visionmediahq/spam-guard#semver:^1.0.0`): string[] {
  const changed: string[] = []
  const write = (rel: string, content: string) => {
    const path = join(dir, rel)
    if (existsSync(path) && readFileSync(path, 'utf8') === content) return
    writeFileSync(path, content)
    changed.push(rel)
  }

  // package.json
  const pkgPath = join(dir, 'package.json')
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  pkg.dependencies ??= {}
  pkg.dependencies[PKG] = spec
  for (const dep of ['altcha', 'altcha-lib']) {
    delete pkg.dependencies[dep]
    if (pkg.devDependencies) delete pkg.devDependencies[dep]
  }
  pkg.dependencies = Object.fromEntries(Object.entries(pkg.dependencies).sort(([a], [b]) => a.localeCompare(b)))
  write('package.json', JSON.stringify(pkg, null, 2) + '\n')

  // Delete the copies and the tests that moved.
  const remove = [
    ...Object.keys(LIB_ENTRY).map((name) => `src/lib/${name}.ts`),
    'src/lib/spam-test-utils.ts',
    ...COMPONENTS.map((name) => `src/components/${name}.astro`),
    ...MOVED_TESTS,
  ]
  for (const rel of remove) {
    if (existsSync(join(dir, rel))) {
      rmSync(join(dir, rel))
      changed.push(`deleted ${rel}`)
    }
  }

  for (const [rel, content] of Object.entries(ROUTES)) write(rel, content)

  // Imports everywhere else in src.
  for (const path of filesUnder(join(dir, 'src')).filter((f) => /\.(ts|astro|mjs|js|tsx|jsx)$/.test(f))) {
    const rel = relative(dir, path)
    if (rel in ROUTES) continue
    const source = readFileSync(path, 'utf8')
    write(rel, rewriteImports(source, rel))
  }

  // Tailwind: the stylesheet(s) that load Tailwind.
  const sheets = filesUnder(join(dir, 'src')).filter((f) => f.endsWith('.css') && /@import "tailwindcss"/.test(readFileSync(f, 'utf8')))
  if (sheets.length === 0) fail('no stylesheet with @import "tailwindcss" under src/')
  for (const path of sheets) write(relative(dir, path), wireCss(readFileSync(path, 'utf8')))

  const config = ['astro.config.ts', 'astro.config.mjs', 'astro.config.mts'].find((f) => existsSync(join(dir, f)))
  if (!config) fail('no astro.config.{ts,mjs,mts}')
  write(config, wireAstroConfig(readFileSync(join(dir, config), 'utf8')))

  return changed
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, spec] = process.argv.slice(2)
  if (!dir) {
    console.error('usage: node --experimental-strip-types ci/wire-starter.ts <site dir> [dependency spec]')
    process.exit(2)
  }
  for (const line of wire(dir, spec)) console.log(line)
}
