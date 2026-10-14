# Changelog

Each version says whether a site needs to change anything after upgrading.

## 1.0.0

First release: the spam guard from astro-starter (main at d843fa4) as a package. Site action
needed when moving from the copied files: yes (see README, "Install" and "Wire a site").

- Server: `checkSubmission`, `checkResponse`, `guardSubmission` — honeypot, fail-closed
  configuration check, rate limit (5 verified posts per 10 minutes per client), reCAPTCHA v3 or
  ALTCHA, content flags.
- Browser: `/client` (`preloadSpamCheck`, `addSpamToken`, `getSpamFields`, `spamSubmitted`,
  `SpamCheckError`) and the `/recaptcha-client` compat helpers.
- Routes: `/routes/form-config` and `/routes/altcha-challenge` (GET), re-exported by the site.
- Components: `SpamNotice`, `FormStatus`, `HoneypotField`.
- `withFormRedirect` / `formRedirect`, `env`, `telHref`, the field names.

Changes from the copied files:

- `SpamNotice` and `FormStatus` take `lang: 'sv' | 'en'` (default `'sv'`, the same texts as before).
- `env(key)` accepts any key, so a site's own route reads `RESEND_API_KEY`, `CONTACT_*` through it.
  Production still reads `process.env` only.
