// Content rules for form submissions. They never drop a message: a match only
// returns a flag, and the endpoint prefixes the e-mail subject with
// "[misstänkt spam] " so no real lead is lost and the rules can be judged.

import { SPAM_FIELDS } from './spam-fields'

export type Flag = 'links' | 'length' | 'script' | 'gibberish'

const MAX_LINKS = 2
const MAX_FIELD_CHARS = 5000
const MAX_NON_LATIN_SHARE = 0.3
const MIN_LETTERS_FOR_SCRIPT = 20
const LINK = /\b(?:https?:\/\/|www\.)\S+/gi // one match per link, not per prefix

const spamFields: ReadonlySet<string> = new Set(SPAM_FIELDS)

// Gibberish (#21): bots that solve the challenge fill every field with one random mixed-case
// token ("hwcxfAXYrTLOWycHCCtig"). A field counts when its whole value is letters only, at
// least MIN_GIBBERISH_LETTERS long, switches case at least MIN_CASE_SWITCHES times and has a run
// of two or more capitals inside the word ("fAXYr"). CamelCase ("MacBookProMax") has its
// capitals one at a time; names, words and all-caps don't switch; codes have digits.
const MIN_GIBBERISH_LETTERS = 12
const MIN_CASE_SWITCHES = 5
const LETTERS_ONLY = /^\p{L}+$/u
const CAPITALS_INSIDE = /\p{Ll}\p{Lu}{2,}\p{Ll}/u

function isGibberish(value: string): boolean {
  const v = value.trim()
  if (v.length < MIN_GIBBERISH_LETTERS || !LETTERS_ONLY.test(v) || !CAPITALS_INSIDE.test(v)) return false
  let switches = 0
  for (let i = 1; i < v.length; i++) {
    const prevUpper = v[i - 1] !== v[i - 1]?.toLowerCase()
    const upper = v[i] !== v[i]?.toLowerCase()
    if (prevUpper !== upper) switches++
  }
  return switches >= MIN_CASE_SWITCHES
}

/** The fields whose whole value looks like a bot's random token, in body order. Names only, never values. */
export function gibberishFields(fields: Record<string, unknown>): string[] {
  return Object.entries(fields)
    .filter(([key, value]) => !spamFields.has(key) && typeof value === 'string' && isGibberish(value))
    .map(([key]) => key)
}

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
  if (gibberishFields(fields).length) return 'gibberish'
  return undefined
}
