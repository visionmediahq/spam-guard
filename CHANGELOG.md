# Changelog

Each version says whether a site needs to change anything after upgrading.

## 1.4.0

Site action needed: no. To block a sender, set `SPAM_BLOCK` on the app and restart it (README,
"Blocking a sender").

- Sender blocklist (#20). `SPAM_BLOCK` (runtime variable) and the new `block` option of
  `checkSubmission` take `email:address`, `email:@domain` and `phone:number` entries, separated by
  commas, semicolons or line breaks. A verified post with a field whose whole value is a listed
  address or number gets the fake success and is dropped, logged as
  `blocked kind=email|domain|phone provider=…` without the value. It counts toward the rate limit.
  - Checked after the provider, so an unverified post fails as before, and before the honeypot
    verdict, so a blocked sender's password manager can't get a post sent.
  - Free text is never searched, in any field, so a customer who mentions a blocked address or
    number is not dropped.
  - E-mail ignores case, plus addressing, quotes, `mailto:`, zero-width spaces and trailing
    punctuation. A domain covers its subdomains; a whole e-mail provider (`@gmail.com`) or public
    suffix (`@co.uk`) is refused. Phone numbers compare whole: `+46 70 …` = `0046 70 …` = `070-…`,
    `+1 555 …` = `001 555 …`; another area code never matches, and a number without `0`, `+` or
    `00` in front never matches and is not a valid entry. Several numbers in one field are split
    apart.
  - A bad or refused entry is skipped with one warning naming its position, never its value.
  - `block` also accepts a single string, for plain-JS routes.
- Includes 1.3.1.

## 1.3.1

Site action needed: no. Upgrade to stop gibberish bot posts reaching clients as `[misstänkt spam]`.

- `checkSubmission`: a verified post with a filled honeypot is sent with `flag: 'honeypot'` only if
  the honeypot value matches another field, as a password manager's autofill does. Otherwise it is
  a bot that solves the challenge: fake success, dropped. In 1.3.0 every verified honeypot hit was
  sent, which let random-string spam through (#21).
  - Text ignores case, Unicode composition (å/ä/ö) and everything but letters, digits and `@`.
    The honeypot needs at least 3 letters or digits and at most 254 characters. Part of a value
    counts either way round (`Anna` = `Anna Svensson`), and so does one word of the honeypot
    (`Anna Svensson` = `Anna S.`), and a name split over fields (`Bo` + `Ek` = `Bo Ek`). In free
    text (more than 6 words, or over 80 characters once spaces and punctuation are gone) only the
    whole honeypot counts, with at least 6 characters.
  - Phone numbers compare as national numbers, so `+46 8 12 34 56`, `0046 8 12 34 56`,
    `+46 (0)8 12 34 56` and `08-12 34 56` match, also with text around the number or two numbers
    in one field.
  - Every field counts, `messageFields` included, and numbers, arrays and nested objects in JSON
    bodies.
  - A drop is logged with the shape of the honeypot value, never the value:
    `honeypot token=yes match=no kind=token|email|phone|words len=… provider=…`. A `kind` other
    than `token` is worth a look: it may be a real visitor's autofill that didn't match.

## 1.3.0

Site action needed: no. Routes that prefix the subject when `spam.flag` is set flag the new case
on their own.

- `HoneypotField`: the input carries `data-1p-ignore`, `data-lpignore="true"`, `data-bwignore` and
  `data-form-type="other"`, so password managers (which ignore `autocomplete="off"`) leave it empty.
- `checkSubmission`: a filled honeypot that comes with a spam token is no longer dropped on sight.
  The token is verified as usual; if it passes, the post is sent with `flag: 'honeypot'` and logged
  as `honeypot-overridden`. If it fails, the fake success and the `honeypot token=yes` line stay.
  A filled honeypot without a token is dropped as before. Before, an autofilled honeypot lost a
  real visitor's message while they saw a confirmation (astro-starter#63).

## 1.2.1

Site action needed: no.

- `SpamNotice`: no space before the full stop after the e-mail link ("… eller mejla info@… ."),
  on Astro 7 sites that set `compressHTML: true` (and in Astro 6's default). The fixture now builds
  with `compressHTML: true` and checks the notice's ending.

## 1.2.0

Site action needed: no. Sites that pass a phone number or an e-mail address render the same as 1.1.0.

- `SpamNotice` and `FormStatus` work without a phone number and without an e-mail address, for a
  site that publishes neither: the texts ask the visitor to turn on JavaScript and try again
  (new parts `turnOn`, `retry`, `waitRetry`). 1.1.0 stopped the page with an error instead.

## 1.1.0

Site action needed: no. Sites that pass neither new option render the same as 1.0.0, apart
from the fix below.

- `SpamNotice` and `FormStatus`: `phone` is optional. Without it, the notice and the replies
  point to `email` ("Mejla oss på …" / "E-mail us at …"); one of the two is required: without
  both the page fails to render (the build, for a prerendered page) with a message.
- `SpamNotice` and `FormStatus`: `text` replaces any part of the wording, for a site with its own
  voice (`{ sent: 'Tack! Jag hör av mig så snart jag kan.' }`). Parts and defaults in the README.
- Fix: under Astro 7 the "too many messages" reply had no space before the phone link
  ("ring oss på063-…"). The space is now explicit.

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
