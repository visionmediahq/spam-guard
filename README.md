# @visionmediahq/spam-guard

Spam protection for the forms on Vision Media's Astro sites.

- A honeypot field, then one provider per site: Google reCAPTCHA v3 (default) or ALTCHA
  (self-hosted proof-of-work: no Google, no cookies).
- Fails closed: missing configuration, a provider error or an unreachable Google rejects the post
  (503 / 400) instead of sending unverified mail. Only `astro dev` lets posts through on the
  honeypot alone.
- 5 verified posts per client per 10 minutes. Content rules (many links, very long fields, mostly
  non-Latin text) never drop a message; they only flag it.
- A browser post without JavaScript gets a 303 back to the form with `#skickat`, `#fel` or `#vanta`,
  shown by `<FormStatus />`.
- Swedish texts by default, English with `lang="en"`.

Requires Astro 6 or 7 with `output: 'server'` (Node adapter), Tailwind 4 and DaisyUI 5.

## Install

```json
"dependencies": {
  "@visionmediahq/spam-guard": "github:visionmediahq/spam-guard#semver:^1.0.0"
}
```

Run `npm install` on a machine with git and **commit `package-lock.json`**. Builds without git
(Docker) then download the pinned commit as a tarball with `npm ci`; an install without a lockfile
fails there. That download needs no token only because this repo is public, and it needs GitHub
reachable: if it isn't, the deploy's build fails and the running container keeps serving.

The site needs `.npmrc` with `legacy-peer-deps=true`, copied before every `npm ci` in the
Dockerfile (`COPY package*.json .npmrc ./`); add both if the site lacks them, then write the
lockfile. Without it, Astro's h3 1.x (via unstorage) clashes with altcha-lib's optional h3 2 peer:
npm 10 and 11 resolve that differently, and `npm ci` in the image can stop with "Missing" or
"Invalid" h3 / crossws "from lock file", whichever npm wrote the lockfile.

The package owns `altcha` and `altcha-lib`: remove them from the site's own dependencies.

## Wire a site

1. `src/styles/global.css`, after the Tailwind imports, so Tailwind generates the components' classes:

   ```css
   @source "../../node_modules/@visionmediahq/spam-guard/src";
   ```

2. `astro.config.ts`, so `astro dev` serves the browser helper (its worker import uses `?url`,
   which Vite's dependency pre-bundling cannot read; builds work either way):

   ```ts
   vite: {
     plugins: [tailwindcss()],
     optimizeDeps: { exclude: ['@visionmediahq/spam-guard'] },
   },
   ```

3. The two routes the browser helper calls, at exactly these paths:

   ```ts
   // src/pages/api/form-config.ts
   export { GET } from '@visionmediahq/spam-guard/routes/form-config'
   export const prerender = false
   ```

   ```ts
   // src/pages/api/altcha-challenge.ts
   export { GET } from '@visionmediahq/spam-guard/routes/altcha-challenge'
   export const prerender = false
   ```

   `prerender` must be in the page file itself: Astro does not read it through a re-export.

## Wire a form (3 places)

1. **Markup.** `<SpamNotice />` above the form (shown only without JavaScript: in both modes the
   form needs it), `<HoneypotField />` and `<FormStatus />` inside it:

   ```astro
   ---
   import SpamNotice from '@visionmediahq/spam-guard/components/SpamNotice.astro'
   import HoneypotField from '@visionmediahq/spam-guard/components/HoneypotField.astro'
   import FormStatus from '@visionmediahq/spam-guard/components/FormStatus.astro'
   ---
   <SpamNotice phone="063-12 34 56" email="info@kund.example" />
   <form method="post" action="/api/contact">
     …
     <HoneypotField />
     <FormStatus phone="063-12 34 56" email="info@kund.example" />
   </form>
   ```

   | Prop | Components | Meaning |
   |---|---|---|
   | `phone` | SpamNotice, FormStatus | Phone number as displayed. |
   | `phoneHref` | SpamNotice, FormStatus | `tel:` link when the displayed number can't be turned into one. |
   | `email` | SpamNotice, FormStatus | Optional e-mail address in the message. |
   | `lang` | SpamNotice, FormStatus | `'sv'` (default) or `'en'`. |
   | `form` | FormStatus | Only with more than one form on a page: a name per form (`a-z`, `0-9`, `-`), so the reply shows at the form that was sent (`#offert-fel`). |

2. **Submit script.**

   ```ts
   import { preloadSpamCheck, addSpamToken, spamSubmitted, SpamCheckError } from '@visionmediahq/spam-guard/client'

   if (form) preloadSpamCheck(form)
   let sending = false
   form.addEventListener('submit', async (event) => {
     event.preventDefault()
     if (sending) return                 // a payload is single-use: never post twice
     sending = true
     try {
       const data = new FormData(form)
       try {
         await addSpamToken(form, data, 'contact')   // or getSpamFields(form, 'contact') for JSON
       } catch (err) {
         if (err instanceof SpamCheckError) { /* show "ring oss" */ return }
         throw err
       }
       const res = await fetch('/api/contact', { method: 'POST', body: data })
       // …
     } finally {
       spamSubmitted(form)               // always: prepares a fresh solution for a retry
       sending = false
     }
   })
   ```

   Older forms on `addRecaptchaToken` / `preloadRecaptcha` (`@visionmediahq/spam-guard/recaptcha-client`)
   keep working in `recaptcha` mode only; move them before switching a site to `altcha`.

3. **API route.** Run the guard before validating or sending, with the same action name as the
   script, and always pass `request`:

   ```ts
   import { checkResponse, checkSubmission } from '@visionmediahq/spam-guard'
   import { env } from '@visionmediahq/spam-guard/env'
   import { withFormRedirect } from '@visionmediahq/spam-guard/form-redirect'

   async function handle(request: Request): Promise<Response> {
     const fields = Object.fromEntries(await request.formData())
     const spam = await checkSubmission(fields, request, { action: 'contact', messageFields: ['message'] })
     const stop = checkResponse(spam)    // honeypot → fake success, else 400 / 429 / 503
     if (stop) return stop
     // validate, then send; prefix the subject with '[misstänkt spam] ' when spam.flag is set
   }

   export const POST = withFormRedirect(handle)
   ```

   `guardSubmission(fields, action, request)` is the short form when the flag is not needed.
   Read the route's own settings (`RESEND_API_KEY`, `CONTACT_TO`, …) with `env()` too: it reads
   `process.env` at runtime in production and `.env` in `astro dev`, and never puts build-time
   values into the server bundle.

Other entry points: `@visionmediahq/spam-guard/phone` (`telHref`), `@visionmediahq/spam-guard/fields`
(the field names), `formRedirect` from `/form-redirect`.

## Environment

All read at runtime (`process.env`); no build variables.

| Variable | Meaning |
|---|---|
| `SPAM_PROVIDER` | `recaptcha` (default when unset) or `altcha`. Anything else rejects every post (503). |
| `SITE_URL` | The site's URL. reCAPTCHA tokens must come from its host. |
| `PUBLIC_RECAPTCHA_SITE_KEY`, `RECAPTCHA_SECRET_KEY` | reCAPTCHA v3 keys (recaptcha mode). |
| `RECAPTCHA_ALLOWED_HOSTS` | Extra token hosts besides `SITE_URL`'s, comma-separated. |
| `ALTCHA_HMAC_SECRET` | altcha mode: at least 32 characters, unique per app (`openssl rand -hex 32`), never shared between apps. |

## Switching a site to ALTCHA

Every form must use `/client` (not the reCAPTCHA compat helpers). Set `SPAM_PROVIDER=altcha` and
`ALTCHA_HMAC_SECRET` before deploying, or every post answers 503.

## Upgrading

Sites depend on `semver:^1.0.0`, so a site picks up a new 1.x tag at its next `npm install`
(`npm install --package-lock-only @visionmediahq/spam-guard` updates only the lockfile; run it with
the site's `.npmrc` in place, see [Install](#install)). Read
`CHANGELOG.md`: each version says whether a site needs to change anything.

## Development

```bash
npm ci
npm run check                                   # tsc
npm test                                        # vitest
npm run test:fixture -- 7.3.8 11.1.7            # pack → install into fixture/site → build, start, post test
npm run test:pack -- 7.3.8 11.1.7               # the same (astro-consent's name for it)
node --experimental-strip-types ci/wire-starter.ts <site dir> [dependency spec]   # copies → package
```

`ci/` and `fixture/` are repo tools: `files` is `["src"]`, so sites never install them.

## Releasing

CI green on `main` **including the `starter-install` job** (repo variable `STARTER_INSTALL=true` and
secret `STARTER_READ_TOKEN`), then bump `version`, add the `CHANGELOG.md` entry, tag `vX.Y.Z` and
push the tag. A pushed tag is live for every site on `semver:^1.0.0` at its next install. Tags are
never moved or deleted. Never add a script named `prepare`, `preinstall`, `install`, `postinstall`,
`prepack` or `build`, or a `workspaces` field, to `package.json`: a git dependency with one makes
npm install dev dependencies inside the site's Docker build.

Security fixes: see `SECURITY.md`.
