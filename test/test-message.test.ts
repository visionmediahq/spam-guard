import { describe, expect, test } from 'vitest'
import { formFields, parseArgs, testMessage, SUBJECT } from '../ci/test-message'

describe('the standard test message (#9)', () => {
  test('fixed text, then the site host and the spam-guard version', () => {
    expect(testMessage('gklaven.se', '1.4.0')).toBe(
      'TEST – inget att åtgärda. Vi har uppdaterat skyddet mot skräppost i kontaktformuläret och ' +
        'kontrollerar att meddelanden kommer fram. Ni behöver inte svara. Hälsningar, Vision Media\n\n' +
        'Sida: gklaven.se · spam-guard v1.4.0',
    )
    expect(testMessage('x.se', undefined)).toMatch(/Sida: x\.se · spam-guard version okänd$/)
  })

  test('the standard fields, with an empty honeypot', () => {
    const f = formFields({ host: 'gklaven.se', version: '1.4.0' })
    expect(f).toEqual({
      name: 'Vision Media (test)',
      email: 'support@visionmedia.io',
      company: 'Vision Media',
      subject: SUBJECT,
      message: testMessage('gklaven.se', '1.4.0'),
      hp_x7q2: '',
    })
    expect(SUBJECT).toBe('TEST från Vision Media (kan ignoreras)')
  })

  test('a phone only when given, renamed and extra fields for odd forms', () => {
    const f = formFields({
      host: 'h.se',
      version: '1.4.0',
      phone: '070-000 00 00',
      map: { namn: 'name', meddelande: 'message' },
      extra: { antal: '20' },
    })
    expect(f.phone).toBe('070-000 00 00')
    expect(f.namn).toBe('Vision Media (test)')
    expect(f.meddelande).toMatch(/^TEST – inget att åtgärda/)
    expect(f.name).toBeUndefined()
    expect(f.message).toBeUndefined()
    expect(f.antal).toBe('20')
    expect(f.hp_x7q2).toBe('')
  })

  test('arguments: url, dry run by default, --send, repeated --map and --field', () => {
    const a = parseArgs(['https://gklaven.se/', '--repo', 'gklaven', '--map', 'namn=name', '--field', 'antal=20', '--field', 'typ=offert'], {})
    expect(a).toMatchObject({
      base: 'https://gklaven.se',
      path: '/api/contact',
      repo: 'gklaven',
      send: false,
      map: { namn: 'name' },
      extra: { antal: '20', typ: 'offert' },
    })
    expect(parseArgs(['https://x.se', '--send', '--path', '/api/offert'], { TEST_PHONE: '070-1' })).toMatchObject({
      send: true,
      path: '/api/offert',
      phone: '070-1',
    })
  })

  test('bad arguments are refused', () => {
    expect(() => parseArgs([], {})).toThrow(/usage/)
    expect(() => parseArgs(['x.se'], {})).toThrow(/https?:\/\//)
    expect(() => parseArgs(['https://x.se', '--map', 'namn=nope'], {})).toThrow(/--map/)
    expect(() => parseArgs(['https://x.se', '--wat'], {})).toThrow(/--wat/)
  })
})
