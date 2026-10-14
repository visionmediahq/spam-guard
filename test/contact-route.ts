// Test-only form route, shaped like a site's src/pages/api/contact.ts: the spam
// check, field validation and a "send" into `sent`, wrapped in withFormRedirect.
// Lets the endpoint tests run the whole chain without an e-mail provider.

import { checkResponse, checkSubmission } from '../src/lib/spam-guard'
import { withFormRedirect } from '../src/lib/form-redirect'

export const sent: Array<{ subject: string }> = []

function json(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  })
}

async function parseRequestBody(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = (request.headers.get('Content-Type') ?? '').toLowerCase()
  try {
    return contentType.includes('application/json')
      ? await request.json()
      : Object.fromEntries(await request.formData())
  } catch {
    return null
  }
}

async function handle(request: Request): Promise<Response> {
  const raw = await parseRequestBody(request)
  if (!raw) return json({ success: false, error: 'Invalid request body.' }, 400)

  const spam = await checkSubmission(raw, request, { action: 'contact', messageFields: ['message'] })
  const spamResponse = checkResponse(spam)
  if (spamResponse) return spamResponse

  const str = (key: string) => String(raw[key] ?? '').trim()
  const [name, email, message] = [str('name'), str('email'), str('message')]
  if (![name, email, message].every(Boolean)) return json({ success: false, error: 'Name, email, and message are required.' }, 400)

  sent.push({ subject: `${spam.flag ? '[misstänkt spam] ' : ''}Kontaktformulär: ${name}` })
  return json({ success: true })
}

export const POST = withFormRedirect(handle)
