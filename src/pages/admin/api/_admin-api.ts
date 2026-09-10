/**
 * The small shared middle of the editor's two endpoints.
 *
 * Underscore-prefixed, so Astro does not route it: this is not a page.
 *
 * These exist because the editor never navigates. It is one screen that creates
 * a gallery and then keeps changing it while photos are still uploading, so a
 * form POST and a redirect would throw away the queue -- the whole reason the
 * wizard's two pages became one. JSON over `fetch` is the only shape that lets
 * the screen stay put.
 */
import type { APIContext } from 'astro';
import { ADMIN_COOKIE, isAdmin } from '../../../../server/sessions.js';

export function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/**
 * 403 with a sentence she can act on, rather than a redirect to the login page.
 * A redirect would arrive at `fetch` as an HTML body where JSON was expected,
 * and surface as "something went wrong" — when what actually happened is that
 * the session expired while the tab sat open overnight.
 */
export function refuseUnlessAdmin({ cookies }: APIContext) {
  if (isAdmin(cookies.get(ADMIN_COOKIE)?.value)) return null;
  return json({ error: 'Sesja wygasła. Zaloguj się ponownie w nowej karcie.' }, 403);
}

/** Malformed JSON is a bug in our own code, not something she can fix. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}
