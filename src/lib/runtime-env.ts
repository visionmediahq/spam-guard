// Server-side environment access for API routes.
//
// `import.meta.env.*` is inlined by Vite at build time, so in the Docker image
// it only holds values that were present during `npm run build`. `process.env`
// is Coolify's runtime environment and is the only source in production — no
// "Build Variable" needed. The inlined values only serve `astro dev`, where
// `.env` is loaded into `import.meta.env` but not into `process.env`. They are
// left out of production builds, so a value baked in at build time can never
// stand in for a runtime variable that was removed, and secrets ticked as
// build variables don't end up in the server bundle.
//
// Never import this from client code.

const devEnv = {
  SITE_URL: import.meta.env.SITE_URL,
  RESEND_API_KEY: import.meta.env.RESEND_API_KEY,
  CONTACT_FROM: import.meta.env.CONTACT_FROM,
  CONTACT_TO: import.meta.env.CONTACT_TO,
  PUBLIC_RECAPTCHA_SITE_KEY: import.meta.env.PUBLIC_RECAPTCHA_SITE_KEY,
  RECAPTCHA_SECRET_KEY: import.meta.env.RECAPTCHA_SECRET_KEY,
  RECAPTCHA_ALLOWED_HOSTS: import.meta.env.RECAPTCHA_ALLOWED_HOSTS,
  SPAM_PROVIDER: import.meta.env.SPAM_PROVIDER,
  ALTCHA_HMAC_SECRET: import.meta.env.ALTCHA_HMAC_SECRET,
} as const

export type RuntimeEnvKey = keyof typeof devEnv

// Vite replaces import.meta.env.DEV with false in production builds, and the
// bundler then drops devEnv and its inlined values entirely.
const buildTimeEnv: Partial<Record<RuntimeEnvKey, string | undefined>> = import.meta.env.DEV ? devEnv : {}

/** A trimmed env value, or undefined when unset or empty. */
export function env(key: RuntimeEnvKey): string | undefined {
  const value = (process.env[key] ?? buildTimeEnv[key])?.trim()
  return value || undefined
}
