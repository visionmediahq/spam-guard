import type { APIContext, APIRoute } from 'astro'

// Replies for a browser's own form post: a visitor with JavaScript off submits the
// <form> natively, and a JSON reply would show up as a bare page. Such a post is sent
// back to the page it came from, with #skickat, #fel or #vanta; <FormStatus /> in the
// form shows the matching message through CSS :target, without JavaScript. A page with
// more than one form names each <FormStatus form="…" />; the name comes back in the
// hidden field form_status and prefixes the fragment (#offert-fel). <FormStatus /> also
// sends the page's own path (form_return), so the reply finds the form even when the
// browser sends no Referer.

/** Hidden fields <FormStatus /> adds to the form. */
export const FORM_STATUS_FIELD = 'form_status'
export const FORM_RETURN_FIELD = 'form_return'
/** Valid <FormStatus form="…" /> names: lowercase letters, digits and '-'. */
export const FORM_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/

/** What a no-JS reply needs from the posted form. */
export interface FormReplyTarget {
  name?: string
  returnTo?: string
}

/**
 * True for a browser's own form post (a page navigation), false for a script. Browsers
 * say so in Sec-Fetch-Mode (navigate vs cors/same-origin); without that header, a
 * non-JSON body that asks for HTML counts as one. fetch() keeps Accept: *\/*.
 */
export function isBrowserFormPost(request: Request): boolean {
  const type = (request.headers.get('Content-Type') ?? '').toLowerCase()
  if (type.includes('application/json')) return false
  const mode = request.headers.get('Sec-Fetch-Mode')
  if (mode) return mode.toLowerCase() === 'navigate'
  return (request.headers.get('Accept') ?? '').toLowerCase().includes('text/html')
}

/** The posted form's FormStatus fields, read from a clone so the route can still read the body. */
export async function formReplyTarget(request: Request): Promise<FormReplyTarget> {
  try {
    const data = await request.clone().formData()
    const str = (key: string) => {
      const value = data.get(key)
      return typeof value === 'string' ? value : undefined
    }
    return { name: str(FORM_STATUS_FIELD), returnTo: str(FORM_RETURN_FIELD) }
  } catch {
    return {}
  }
}

/**
 * A path on this site, or null. Parsed the way a browser parses Location (it strips tabs and
 * newlines and reads '\\' as '/'), so nothing that passes here can point at another host.
 */
function localPath(value: string | undefined): string | null {
  if (!value?.startsWith('/')) return null
  const base = 'https://local.invalid'
  try {
    const url = new URL(value, base)
    // '//host' would still be read as another site, even though it parsed as a path here.
    if (url.origin !== base || url.pathname.startsWith('//')) return null
    return url.pathname + url.search
  } catch {
    return null
  }
}

/** Where the reply goes: the form's own path, else the Referer's path, else the start page. */
function returnPath(request: Request, returnTo?: string): string {
  const own = localPath(returnTo)
  if (own) return own
  try {
    const { pathname, search } = new URL(request.headers.get('Referer') ?? '')
    return localPath(pathname + search) ?? '/'
  } catch {
    return '/'
  }
}

/**
 * Turns an endpoint's reply into a 303 back to the form: 2xx → #skickat, 429 → #vanta,
 * else #fel, prefixed with the form's FormStatus name when it has a valid one.
 */
export function formRedirect(request: Request, reply: Response, target: FormReplyTarget = {}): Response {
  const result = reply.ok ? 'skickat' : reply.status === 429 ? 'vanta' : 'fel'
  const fragment = target.name && FORM_NAME.test(target.name) ? `${target.name}-${result}` : result
  return new Response(null, {
    status: 303,
    headers: { Location: `${returnPath(request, target.returnTo)}#${fragment}`, 'Cache-Control': 'no-store' },
  })
}

/**
 * Wraps a form route's handler: scripts get its reply unchanged; a browser's own form post
 * gets a 303 back to the form, also when the handler throws. Use for every form route:
 * `export const POST = withFormRedirect(handle)`. The handler also gets the route's context
 * (clientAddress, locals, …) when it needs more than the request.
 */
export function withFormRedirect(
  handle: (request: Request, context: APIContext) => Promise<Response>,
): APIRoute {
  return async (context) => {
    const { request } = context
    if (!isBrowserFormPost(request)) return handle(request, context)
    const target = await formReplyTarget(request)
    let reply: Response
    try {
      reply = await handle(request, context)
    } catch (err) {
      // An unexpected error must not leave a no-JS visitor on a bare 500 page.
      console.error('[form] Unhandled error:', err)
      reply = new Response(null, { status: 500 })
    }
    return formRedirect(request, reply, target)
  }
}
