// A site's own form route: its fields, the spam check, one e-mail through Resend's HTTP API.
import { checkResponse, checkSubmission } from '@visionmediahq/spam-guard'
import { env } from '@visionmediahq/spam-guard/env'
import { withFormRedirect } from '@visionmediahq/spam-guard/form-redirect'

export const prerender = false

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } })
}

async function handle(request: Request): Promise<Response> {
  const apiKey = env('RESEND_API_KEY')
  const to = env('CONTACT_TO')
  const from = env('CONTACT_FROM')
  if (!apiKey || !to || !from) {
    console.error('[contact] Missing env variables: RESEND_API_KEY, CONTACT_TO or CONTACT_FROM')
    return json({ success: false, error: 'Server configuration error.' }, 503)
  }

  let raw: Record<string, unknown>
  try {
    raw = Object.fromEntries(await request.formData())
  } catch {
    return json({ success: false, error: 'Invalid request body.' }, 400)
  }

  const spam = await checkSubmission(raw, request, { action: 'contact', messageFields: ['message'] })
  const spamResponse = checkResponse(spam)
  if (spamResponse) return spamResponse

  const str = (key: string) => String(raw[key] ?? '').trim()
  const [name, email, message] = [str('name'), str('email'), str('message')]
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !message) {
    return json({ success: false, error: 'Name, email, and message are required.' }, 422)
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      to: [to],
      reply_to: email,
      subject: `${spam.flag ? '[misstänkt spam] ' : ''}Kontaktformulär: ${name}`,
      text: `Namn: ${name}\nE-post: ${email}\n\n${message}`,
    }),
  })
  if (!res.ok) {
    console.error('[contact] Resend rejected the send:', res.status)
    return json({ success: false, error: 'Failed to send message.' }, 502)
  }
  return json({ success: true })
}

export const POST = withFormRedirect(handle)
