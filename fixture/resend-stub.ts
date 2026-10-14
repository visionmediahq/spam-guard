// Preloaded into the fixture server (node --import): answers Resend's API locally and
// appends one line per send to $STUB_LOG, so the post test never sends real e-mail.
import { appendFileSync } from 'node:fs'

const realFetch = globalThis.fetch
globalThis.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input)
  if (url.startsWith('https://api.resend.com/')) {
    const subject = String(JSON.parse(String(init?.body ?? '{}')).subject ?? '')
    if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, `SEND ${subject}\n`)
    return new Response(JSON.stringify({ id: 'stub' }), { headers: { 'Content-Type': 'application/json' } })
  }
  if (url.includes('google.com/recaptcha')) throw new Error('stub: no Google in the fixture')
  return realFetch(input, init)
}
