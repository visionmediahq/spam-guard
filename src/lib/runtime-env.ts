// Server-side environment access for API routes — the spam guard's own settings
// and any other key a site's route needs (RESEND_API_KEY, CONTACT_TO, …).
//
// `import.meta.env.*` is inlined by Vite at build time, so in a production build
// it only holds values that were present during `npm run build`. `process.env`
// is the server's runtime environment and is the only source in production.
// The inlined values only serve `astro dev`, where `.env` is loaded into
// `import.meta.env` but not into `process.env`. They are left out of production
// builds, so a value baked in at build time can never stand in for a runtime
// variable that was removed, and secrets present at build time don't end up in
// the server bundle.
//
// Never import this from client code.

/** A trimmed env value, or undefined when unset or empty. */
export function env(key: string): string | undefined {
  // Vite replaces import.meta.env.DEV with false in production builds, and the
  // bundler then drops the dev branch and its inlined values entirely.
  const devValue: unknown = import.meta.env.DEV ? import.meta.env[key] : undefined
  const value = (process.env[key] ?? (typeof devValue === 'string' ? devValue : undefined))?.trim()
  return value || undefined
}
