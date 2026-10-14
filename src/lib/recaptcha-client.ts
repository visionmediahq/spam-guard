// Compatibility layer for forms written before spam-client.ts. Existing imports
// keep working and behave as before; new forms use spam-client.ts directly,
// which also supports the ALTCHA provider.
//
// The Google script loader lives in spam-client.ts, so a page never loads it twice.

import { RECAPTCHA_TOKEN_FIELD } from './spam-fields'
import { getConfig, preloadSpamCheck, recaptchaTokenFor } from './spam-client'

/** Start loading the spam check as soon as the visitor interacts with the form. */
export function preloadRecaptcha(form: HTMLFormElement): void {
  preloadSpamCheck(form)
}

/**
 * Fetch a reCAPTCHA token. Returns '' when the site isn't in recaptcha mode, or
 * reCAPTCHA isn't configured or fails to load. In altcha mode Google is never
 * loaded; these forms must move to spam-client.ts before the switch.
 */
export async function getRecaptchaToken(action = 'contact'): Promise<string> {
  const cfg = await getConfig()
  if (cfg?.provider !== 'recaptcha' || !cfg.recaptchaSiteKey) return ''
  return recaptchaTokenFor(cfg.recaptchaSiteKey, action)
}

/** Append a reCAPTCHA token to a FormData submission under the field the server expects. */
export async function addRecaptchaToken(data: FormData, action = 'contact'): Promise<void> {
  const token = await getRecaptchaToken(action)
  if (token) data.set(RECAPTCHA_TOKEN_FIELD, token)
}
