// Form field names shared by the form markup, the browser helper and the
// server-side guard. Kept in their own module so client code can import them
// without pulling in server-only code.

/**
 * Hidden honeypot input — humans never see it, bots fill it in.
 * Deliberately meaningless: browsers autofill fields named like `website` or
 * `company_website`, which silently dropped real messages.
 */
export const HONEYPOT_FIELD = 'hp_x7q2'

/** reCAPTCHA v3 token appended to the submission by the browser helper. */
export const RECAPTCHA_TOKEN_FIELD = 'recaptcha_token'

/** ALTCHA proof-of-work payload (base64 JSON) appended by spam-client.ts. */
export const ALTCHA_FIELD = 'altcha'

/** Fields added by the spam guard — never part of the message itself. */
export const SPAM_FIELDS = [HONEYPOT_FIELD, RECAPTCHA_TOKEN_FIELD, ALTCHA_FIELD] as const

/** Reasons the browser may report to /api/altcha-challenge?fail=. Anything else is ignored. */
export const CLIENT_FAIL_REASONS = ['unsupported', 'config', 'load', 'challenge', 'solve', 'timeout'] as const
export type ClientFailReason = (typeof CLIENT_FAIL_REASONS)[number]

/** Class on the <FormStatus /> blocks; getSpamFields() and spamSubmitted() hide them by it. */
export const FORM_STATUS_CLASS = 'form-status'
