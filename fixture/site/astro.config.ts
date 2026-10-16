import { defineConfig } from 'astro/config'
import node from '@astrojs/node'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  site: 'https://fixture.example',
  output: 'server',
  // Astro 6's default, and what sites on Astro 7 set to keep Astro 6 markup: whitespace
  // inside a component's markup collapses to a space instead of being dropped.
  compressHTML: true,
  security: { checkOrigin: false },
  adapter: node({ mode: 'standalone' }),
  vite: {
    plugins: [tailwindcss()],
    // astro dev: the package's client imports altcha's worker with `?url`, which Vite's
    // dependency pre-bundling cannot read; served unbundled it works. Builds are unaffected.
    optimizeDeps: { exclude: ['@visionmediahq/spam-guard'] },
  },
})
