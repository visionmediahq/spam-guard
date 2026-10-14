import { afterEach, describe, expect, test, vi } from 'vitest'
import { env } from '../src/lib/runtime-env'

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('env', () => {
  test('reads any key, not only the spam guard settings', () => {
    vi.stubEnv('SOME_SITE_KEY', '  value  ')
    expect(env('SOME_SITE_KEY')).toBe('value')
  })

  test('unset or blank is undefined', () => {
    vi.stubEnv('SOME_SITE_KEY', '   ')
    expect(env('SOME_SITE_KEY')).toBeUndefined()
    expect(env('NOT_SET_ANYWHERE_123')).toBeUndefined()
  })
})
