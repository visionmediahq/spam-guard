import type { APIContext } from 'astro'
import { describe, expect, test } from 'vitest'
import { formRedirect, isBrowserFormPost, withFormRedirect } from '../src/lib/form-redirect'

function req(headers: Record<string, string>): Request {
  return new Request('http://localhost/api/contact', { method: 'POST', headers })
}

describe('isBrowserFormPost', () => {
  test('Sec-Fetch-Mode decides when the browser sends it: navigate = form post, anything else = script', () => {
    expect(isBrowserFormPost(req({ 'Sec-Fetch-Mode': 'navigate', Accept: '*/*' }))).toBe(true)
    expect(isBrowserFormPost(req({ 'Sec-Fetch-Mode': 'cors', Accept: 'text/html, application/json' }))).toBe(false)
  })

  test("a browser's own form post (no JavaScript) asks for HTML", () => {
    expect(isBrowserFormPost(req({ 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html,*/*;q=0.8' }))).toBe(true)
  })

  test('a script posting JSON is not one', () => {
    expect(isBrowserFormPost(req({ 'Content-Type': 'application/json', Accept: 'text/html' }))).toBe(false)
    expect(isBrowserFormPost(req({ 'Content-Type': 'Application/JSON', Accept: 'text/html' }))).toBe(false)
  })

  test("a script posting FormData keeps fetch's default Accept and gets JSON", () => {
    expect(isBrowserFormPost(req({ 'Content-Type': 'multipart/form-data; boundary=x', Accept: '*/*' }))).toBe(false)
  })
})

describe('formRedirect', () => {
  const r = (status: number) => new Response(null, { status })

  test('maps the reply to #skickat, #vanta or #fel on the page that posted', () => {
    const from = req({ Referer: 'https://kund.example/kontakt/?a=1' })
    expect(formRedirect(from, r(200)).headers.get('Location')).toBe('/kontakt/?a=1#skickat')
    expect(formRedirect(from, r(429)).headers.get('Location')).toBe('/kontakt/?a=1#vanta')
    for (const s of [400, 500, 502, 503]) expect(formRedirect(from, r(s)).headers.get('Location')).toBe('/kontakt/?a=1#fel')
  })

  test('is a 303 that is never cached', () => {
    const res = formRedirect(req({ Referer: 'https://kund.example/' }), r(200))
    expect(res.status).toBe(303)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  test("prefers the form's own return path, so a stripped Referer still lands on the form", () => {
    expect(formRedirect(req({}), r(400), { returnTo: '/kontakt/' }).headers.get('Location')).toBe('/kontakt/#fel')
    expect(formRedirect(req({ Referer: 'https://kund.example/x' }), r(400), { returnTo: '//evil.example' }).headers.get('Location')).toBe('/x#fel')
    expect(formRedirect(req({}), r(400), { returnTo: 'https://evil.example/' }).headers.get('Location')).toBe('/#fel')
  })

  test("prefixes the fragment with the form's FormStatus name, when it has a valid one", () => {
    const from = req({ Referer: 'https://kund.example/' })
    expect(formRedirect(from, r(400), { name: 'offert' }).headers.get('Location')).toBe('/#offert-fel')
    expect(formRedirect(from, r(200), { name: 'Bad name!' }).headers.get('Location')).toBe('/#skickat')
  })

  test('control characters and other tricks never lead off the site (no open redirect)', () => {
    for (const returnTo of ['/\t/evil.example/x', '/\n/evil.example', '\\evil.example', '/\\evil.example', ' //evil.example', 'javascript:alert(1)']) {
      const loc = formRedirect(req({}), r(400), { returnTo }).headers.get('Location') ?? ''
      expect(new URL(loc, 'https://kund.example').origin).toBe('https://kund.example')
    }
  })

  test('a newline in the return path never breaks the reply', () => {
    expect(() => formRedirect(req({}), r(200), { returnTo: '/kontakt/\r\nSet-Cookie: x=1' })).not.toThrow()
  })

  test('falls back to the start page without a usable Referer', () => {
    expect(formRedirect(req({}), r(400)).headers.get('Location')).toBe('/#fel')
    expect(formRedirect(req({ Referer: 'not a url' }), r(400)).headers.get('Location')).toBe('/#fel')
  })

  test('only ever redirects to a path on this site', () => {
    // The host is dropped, so another site in the Referer can't turn this into an open redirect.
    expect(formRedirect(req({ Referer: 'https://evil.example/phish' }), r(200)).headers.get('Location')).toBe('/phish#skickat')
    expect(formRedirect(req({ Referer: 'https://kund.example//evil.example/x' }), r(200)).headers.get('Location')).toBe('/#skickat')
  })
})

describe('withFormRedirect', () => {
  const ctx = (request: Request) => ({ request, clientAddress: '203.0.113.7' }) as unknown as APIContext

  test('hands the handler the route context, for scripts and for no-JS posts', async () => {
    const seen: string[] = []
    const route = withFormRedirect(async (_request, context) => {
      seen.push(context.clientAddress)
      return new Response('{}', { status: 200 })
    })
    await route(ctx(req({ 'Sec-Fetch-Mode': 'cors' })))
    const res = (await route(ctx(req({ 'Sec-Fetch-Mode': 'navigate', Referer: 'https://kund.example/kontakt/' })))) as Response
    expect(seen).toEqual(['203.0.113.7', '203.0.113.7'])
    expect(res.headers.get('Location')).toBe('/kontakt/#skickat')
  })
})
