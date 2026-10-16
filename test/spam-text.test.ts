import { describe, expect, it } from 'vitest'
import { spamText } from '../src/lib/spam-text'

describe('spamText', () => {
  it('builds the v1.0 sentences from the default parts', () => {
    const sv = spamText()
    expect(`${sv.needsJs} ${sv.call}`).toBe('Formuläret kräver JavaScript. Ring oss på')
    expect(`${sv.failed} ${sv.call}`).toBe('Meddelandet skickades inte. Ring oss på')
    expect(`${sv.wait} ${sv.waitCall}`).toBe('Du har skickat flera meddelanden på kort tid. Vänta en stund, eller ring oss på')
    const en = spamText('en')
    expect(`${en.needsJs} ${en.call}`).toBe('This form needs JavaScript. Call us on')
    expect(`${en.failed} ${en.call}`).toBe('Your message was not sent. Call us on')
    expect(`${en.wait} ${en.waitCall}`).toBe('You have sent several messages in a short time. Please wait a while, or call us on')
  })

  it('replaces only the parts a site gives', () => {
    const t = spamText('en', { sent: 'Thank you! I will get back to you as soon as I can.', call: 'Please call' })
    expect(t.sent).toBe('Thank you! I will get back to you as soon as I can.')
    expect(t.call).toBe('Please call')
    expect(t.or).toBe('or e-mail')
  })
  it('falls back to Swedish for another lang, and keeps defaults for empty parts', () => {
    expect(spamText('de' as never).sent).toBe('Tack! Vi hör av oss så snart vi kan.')
    expect(spamText('sv', { sent: undefined, call: '' }).sent).toBe('Tack! Vi hör av oss så snart vi kan.')
    expect(spamText('sv', { sent: undefined, call: '' }).call).toBe('Ring oss på')
  })

  it('has the no-contact parts (1.2), overridable like the others', () => {
    const sv = spamText()
    expect(`${sv.needsJs} ${sv.turnOn}`).toBe('Formuläret kräver JavaScript. Slå på det för att skicka ett meddelande.')
    expect(`${sv.failed} ${sv.retry}`).toBe('Meddelandet skickades inte. Formuläret kräver JavaScript: slå på det och försök igen.')
    expect(`${sv.wait} ${sv.waitRetry}`).toBe('Du har skickat flera meddelanden på kort tid. Vänta en stund och försök igen.')
    expect(spamText('en', { retry: 'Please try again later.' }).retry).toBe('Please try again later.')
  })
})
