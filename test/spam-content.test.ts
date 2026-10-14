import { describe, expect, test } from 'vitest'
import { contentFlag } from './spam-content'

const MSG = ['message']
const CYRILLIC = 'Здравствуйте, предлагаем услуги продвижения сайта в поисковых системах'

describe('contentFlag — flagged', () => {
  test('more than two links', () => {
    expect(contentFlag({ message: 'a https://x.se b https://y.se c www.z.se' }, MSG)).toBe('links')
  })

  test('links are counted across all fields', () => {
    expect(contentFlag({ name: 'https://x.se', company: 'www.y.se', message: 'se http://z.se' }, MSG)).toBe('links')
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
    expect(contentFlag({ message: 'https://a.se https://b.se https://c.se ' + 'x'.repeat(5001) }, MSG)).toBe('length')
  })
})

describe('contentFlag — not flagged', () => {
  test('exactly two links', () => {
    expect(contentFlag({ message: 'Se https://www.a.se och https://www.b.se' }, MSG)).toBeUndefined()
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
