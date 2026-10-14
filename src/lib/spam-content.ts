// Content rules for form submissions. They never drop a message: a match only
// returns a flag, and the endpoint prefixes the e-mail subject with
// "[misstänkt spam] " so no real lead is lost and the rules can be judged.

import { SPAM_FIELDS } from './spam-fields'

export type Flag = 'links' | 'length' | 'script'

const MAX_LINKS = 2
const MAX_FIELD_CHARS = 5000
const MAX_NON_LATIN_SHARE = 0.3
const MIN_LETTERS_FOR_SCRIPT = 20
const LINK = /\b(?:https?:\/\/|www\.)\S+/gi // one match per link, not per prefix

const spamFields: ReadonlySet<string> = new Set(SPAM_FIELDS)

/**
 * The first rule a submission trips, or undefined.
 *
 * @param fields         The parsed request body
 * @param messageFields  Fields holding the free-text message (the script rule looks only at these)
 */
export function contentFlag(fields: Record<string, unknown>, messageFields: string[]): Flag | undefined {
  const values = Object.entries(fields)
    .filter(([key, value]) => !spamFields.has(key) && typeof value === 'string')
    .map(([, value]) => value as string)

  if (values.some((v) => v.length > MAX_FIELD_CHARS)) return 'length'
  if ((values.join('\n').match(LINK) ?? []).length > MAX_LINKS) return 'links'

  const text = messageFields
    .map((name) => fields[name])
    .filter((v): v is string => typeof v === 'string')
    .join('\n')
  const letters = text.match(/\p{L}/gu) ?? []
  if (letters.length >= MIN_LETTERS_FOR_SCRIPT) {
    const nonLatin = letters.filter((ch) => !/\p{Script=Latin}/u.test(ch)).length
    if (nonLatin / letters.length > MAX_NON_LATIN_SHARE) return 'script'
  }
  return undefined
}
