import { describe, expect, test } from 'vitest'
import { contentFlag, gibberishFields } from '../src/lib/spam-content'

const MSG = ['message']
const CYRILLIC = 'Здравствуйте, предлагаем услуги продвижения сайта в поисковых системах'

describe('contentFlag — flagged', () => {
  test('more than two links', () => {
    expect(contentFlag({ message: 'a https://x.example b https://y.example c www.z.example' }, MSG)).toBe('links')
  })

  test('links are counted across all fields', () => {
    expect(contentFlag({ name: 'https://x.example', company: 'www.y.example', message: 'se http://z.example' }, MSG)).toBe('links')
  })

  test('a message longer than 5000 characters', () => {
    expect(contentFlag({ message: 'x'.repeat(5001) }, MSG)).toBe('length')
  })

  test('any field longer than 5000 characters', () => {
    expect(contentFlag({ name: 'x'.repeat(5001), message: 'hej' }, MSG)).toBe('length')
  })

  test('a mostly non-Latin message', () => {
    expect(contentFlag({ message: CYRILLIC }, MSG)).toBe('script')
  })

  test('the site passes its own message field name', () => {
    expect(contentFlag({ meddelande: CYRILLIC }, ['meddelande'])).toBe('script')
    expect(contentFlag({ meddelande: CYRILLIC }, MSG)).toBeUndefined()
  })

  test('length wins over links', () => {
    expect(contentFlag({ message: 'https://a.example https://b.example https://c.example ' + 'x'.repeat(5001) }, MSG)).toBe('length')
  })
})

describe('contentFlag — not flagged', () => {
  test('exactly two links', () => {
    expect(contentFlag({ message: 'Se https://www.a.example och https://www.b.example' }, MSG)).toBeUndefined()
  })

  test('Swedish text with å, ä and ö', () => {
    expect(contentFlag({ message: 'Hej, jag undrar över pris på åtgärd för vår gräsmatta' }, MSG)).toBeUndefined()
  })

  test('a Cyrillic name in the name field', () => {
    expect(
      contentFlag({ name: 'Дмитрий Иванов', message: 'Hej, jag vill ha en offert på ett nytt tak.' }, MSG)
    ).toBeUndefined()
  })

  test('short non-Latin text below the letter minimum', () => {
    expect(contentFlag({ message: 'Привет' }, MSG)).toBeUndefined()
  })

  test('exactly 5000 characters', () => {
    expect(contentFlag({ message: 'x'.repeat(5000) }, MSG)).toBeUndefined()
  })

  test('spam guard fields are excluded', () => {
    expect(contentFlag({ message: 'ok', altcha: 'x'.repeat(9000), hp_x7q2: '' }, MSG)).toBeUndefined()
  })

  test('non-string values are ignored', () => {
    expect(contentFlag({ message: 'ok', files: new File(['x'.repeat(6000)], 'a.txt'), n: 7 }, MSG)).toBeUndefined()
  })

  test('a missing message field', () => {
    expect(contentFlag({ name: 'Anna' }, MSG)).toBeUndefined()
  })
})

// The bot posts from #21: one token per field, random mixed case.
const BOT = {
  name: 'hwcxfAXYrTLOWycHCCtig',
  subject: 'OTMnsXReosGoBENrOaR',
  message: 'dYKJudPbgHFwCvHxCXhmIrFW',
  company: 'Oxthdmb LLC',
  email: 'el.iyam.a21.9@gmail.com',
  phone: '9662222542',
}

describe('gibberish', () => {
  test('the bot posts from #21 are flagged, every gibberish field named', () => {
    expect(contentFlag(BOT, MSG)).toBe('gibberish')
    expect(gibberishFields(BOT)).toEqual(['name', 'subject', 'message'])
  })

  test('one gibberish field is enough to flag', () => {
    expect(contentFlag({ name: 'Anna Berg', message: 'gVBrbxuZeTrYShgOgTG' }, MSG)).toBe('gibberish')
    expect(gibberishFields({ name: 'Anna Berg', message: 'gVBrbxuZeTrYShgOgTG' })).toEqual(['message'])
  })

  test('real names, words and messages are not', () => {
    const real = [
      'Anna-Karin Svensson', 'Johansson', 'Kalle', 'MacBookProMax', 'McDonald', 'VeryImportantMessage',
      'SVENSSON', 'Hälsningsfrasförlängning', 'iPhone', 'XMLHttpRequest', 'eBay', 'Hej! Kan ni ringa mig?',
      'abcdefghijklmnop', 'ÅSA ÖBERG', 'Ö', '',
    ]
    for (const v of real) expect(gibberishFields({ name: v }), v).toEqual([])
  })

  test('codes with digits or punctuation are not gibberish', () => {
    for (const v of ['A7fK2pQ9xZ3mB8nR', 'ORD-aBcDeFgHiJkL', 'aBcDeFgHiJkL.se', 'xY_zWqRtYuIoP']) {
      expect(gibberishFields({ ref: v }), v).toEqual([])
    }
  })

  test('spam fields and non-strings are ignored', () => {
    expect(gibberishFields({ altcha: 'hwcxfAXYrTLOWycHCCtig', hp_x7q2: 'OTMnsXReosGoBENrOaR', n: 7 })).toEqual([])
  })

  test('the other content rules come first: length and links win over gibberish', () => {
    expect(contentFlag({ name: 'hwcxfAXYrTLOWycHCCtig', message: 'x'.repeat(5001) }, MSG)).toBe('length')
    expect(contentFlag({ name: 'hwcxfAXYrTLOWycHCCtig', message: 'https://a.x https://b.x https://c.x' }, MSG)).toBe('links')
  })

  test('boundaries: 12 letters and 5 case switches', () => {
    expect(gibberishFields({ a: 'abCDefGHijkL' })).toEqual(['a']) // 12 letters, 5 switches
    expect(gibberishFields({ a: 'abCDefGHijkl' })).toEqual([]) // 4 switches
    expect(gibberishFields({ a: 'abCDefGHijL' })).toEqual([]) // 11 letters
    expect(gibberishFields({ a: 'aBcDeFgHiJkLmNoP' })).toEqual([]) // no run of capitals inside
  })
})
