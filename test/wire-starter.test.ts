import { describe, expect, it } from 'vitest'
import { wireCss, wireDockerfile, wireNpmrc } from '../ci/wire-starter.ts'

const SOURCE = '@source "../../node_modules/@visionmediahq/spam-guard/src";'

describe('wireCss', () => {
  it('goes after a one-line daisyui plugin', () => {
    const out = wireCss('@import "tailwindcss";\n@plugin "daisyui";\n\nbody {}\n')
    expect(out).toBe(`@import "tailwindcss";\n@plugin "daisyui";\n${SOURCE}\n\nbody {}\n`)
  })

  it('goes after a multi-line daisyui options block, never inside it', () => {
    const css = '@import "tailwindcss";\n@plugin "daisyui" {\n  themes: false;\n  include: button, input;\n}\n\n.a {}\n'
    expect(wireCss(css)).toBe(
      `@import "tailwindcss";\n@plugin "daisyui" {\n  themes: false;\n  include: button, input;\n}\n${SOURCE}\n\n.a {}\n`,
    )
  })

  it('reads single-quoted imports and plugins', () => {
    expect(wireCss("@import 'tailwindcss';\n.a {}\n")).toBe(`@import 'tailwindcss';\n${SOURCE}\n.a {}\n`)
    expect(wireCss("@import 'tailwindcss';\n@plugin 'daisyui' {\n  logs: false;\n}\n")).toBe(
      `@import 'tailwindcss';\n@plugin 'daisyui' {\n  logs: false;\n}\n${SOURCE}\n`,
    )
  })

  it('goes after the tailwind import without daisyui, and only once', () => {
    const out = wireCss('@import "tailwindcss";\n.a {}\n')
    expect(out).toBe(`@import "tailwindcss";\n${SOURCE}\n.a {}\n`)
    expect(wireCss(out)).toBe(out)
  })
})

describe('wireNpmrc / wireDockerfile', () => {
  it('adds legacy-peer-deps once and copies .npmrc with package*.json', () => {
    expect(wireNpmrc('')).toBe('legacy-peer-deps=true\n')
    expect(wireNpmrc('legacy-peer-deps=true\n')).toBe('legacy-peer-deps=true\n')
    expect(() => wireNpmrc('legacy-peer-deps=false\n')).toThrow()
    const df = 'FROM node:22\nCOPY package*.json ./\nRUN npm ci\n'
    expect(wireDockerfile(df)).toBe('FROM node:22\nCOPY package*.json .npmrc ./\nRUN npm ci\n')
    expect(wireDockerfile(wireDockerfile(df))).toBe(wireDockerfile(df))
  })
})
