// The words SpamNotice and FormStatus show. Each sentence is built from these parts around the
// links, so a site can replace any part (`text` prop) and keep the rest:
//   notice      {needsJs} {call} <phone>[ {or} <e-mail>].     without a phone: {needsJs} {mail} <e-mail>.
//   sent        {sent}
//   not sent    {failed} {call} <phone>[ {or} <e-mail>].      without a phone: {failed} {mail} <e-mail>.
//   wait        {wait} {waitCall} <phone>.                     without a phone: {wait} {waitMail} <e-mail>.
// A site that shows neither a phone number nor an e-mail address (1.2):
//   notice {needsJs} {turnOn}    not sent {failed} {retry}    wait {wait} {waitRetry}
export interface SpamText {
  needsJs: string
  call: string
  or: string
  mail: string
  sent: string
  failed: string
  wait: string
  waitCall: string
  waitMail: string
  turnOn: string
  retry: string
  waitRetry: string
}

export type Lang = 'sv' | 'en'

const TEXT: Record<Lang, SpamText> = {
  sv: {
    needsJs: 'Formuläret kräver JavaScript.',
    call: 'Ring oss på',
    or: 'eller mejla',
    mail: 'Mejla oss på',
    sent: 'Tack! Vi hör av oss så snart vi kan.',
    failed: 'Meddelandet skickades inte.',
    wait: 'Du har skickat flera meddelanden på kort tid.',
    waitCall: 'Vänta en stund, eller ring oss på',
    waitMail: 'Vänta en stund, eller mejla oss på',
    turnOn: 'Slå på det för att skicka ett meddelande.',
    retry: 'Formuläret kräver JavaScript: slå på det och försök igen.',
    waitRetry: 'Vänta en stund och försök igen.',
  },
  en: {
    needsJs: 'This form needs JavaScript.',
    call: 'Call us on',
    or: 'or e-mail',
    mail: 'E-mail us at',
    sent: 'Thank you! We will get back to you as soon as we can.',
    failed: 'Your message was not sent.',
    wait: 'You have sent several messages in a short time.',
    waitCall: 'Please wait a while, or call us on',
    waitMail: 'Please wait a while, or e-mail us at',
    turnOn: 'Please turn it on to send us a message.',
    retry: 'This form needs JavaScript: please turn it on and try again.',
    waitRetry: 'Please wait a while and try again.',
  },
}

/**
 * The texts for `lang`, with the site's own parts (`text`) in place of the defaults. Any other
 * `lang` gives Swedish, as 1.0.0 did; a part given as undefined or '' keeps its default.
 */
export function spamText(lang: Lang = 'sv', text: Partial<SpamText> = {}): SpamText {
  const own = Object.fromEntries(Object.entries(text).filter(([, value]) => typeof value === 'string' && value !== ''))
  return { ...(TEXT[lang] ?? TEXT.sv), ...own }
}
