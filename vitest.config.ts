import { defineConfig } from 'vitest/config'

// DEV is true under vitest; production-path tests stub it with vi.stubEnv('DEV', false).
export default defineConfig({
  test: { environment: 'node', include: ['test/**/*.test.ts'] },
})
