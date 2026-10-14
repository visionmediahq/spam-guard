import type { APIRoute } from 'astro'
import { missingConfig, provider, recaptchaSiteKey } from '../lib/spam-guard'

// Tells the browser which spam provider the site uses, and hands it the public
// reCAPTCHA site key at runtime, so both come from the server's runtime environment
// instead of being baked into the client bundle. The site key is public by
// design; secrets never leave the server. It is sent in recaptcha mode only, so
// a page in any other mode never loads Google.
//
// provider: 'recaptcha' | 'altcha', 'none' in `astro dev` when the provider is
// not configured (the client then sends only the honeypot), null for an
// unknown SPAM_PROVIDER (the server rejects every post).
//
// Never cached: a missing or rotated key must reach visitors as soon as it is
// fixed on the server. The browser asks once per page, so this costs nothing.
//
// Mount at src/pages/api/form-config.ts (the browser helper calls that path):
//   export { GET } from '@visionmediahq/spam-guard/routes/form-config'
//   export const prerender = false   (Astro reads it from the page file only)
export const GET: APIRoute = async () => {
  const devHoneypotOnly = import.meta.env.DEV && (await missingConfig()) !== null
  const current = devHoneypotOnly ? 'none' : provider()
  return new Response(
    JSON.stringify({
      provider: current,
      recaptchaSiteKey: current === 'recaptcha' ? (recaptchaSiteKey() ?? null) : null,
    }),
    {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    }
  )
}
