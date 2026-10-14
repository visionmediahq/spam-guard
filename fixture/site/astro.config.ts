import { defineConfig } from 'astro/config'
import node from '@astrojs/node'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  site: 'https://fixture.example',
  output: 'server',
  security: { checkOrigin: false },
  adapter: node({ mode: 'standalone' }),
  vite: {
    plugins: [tailwindcss()],
    // astro dev: the package's client imports altcha's worker with `?url`, which Vite's
    // dependency pre-bundling cannot read; served unbundled it works. Builds are unaffected.
    optimizeDeps: { exclude: ['@visionmediahq/spam-guard'] },
  },
})
