/**
 * POST — the uploader saying whether it is still sending photos here.
 *
 * `{ clientId, state }`, where state is 'uploading' or 'done'. One client id
 * per page-load of PhotoUploader, so two devices uploading into one gallery are
 * two records and the worker waits for both — see server/uploaders.js, which is
 * the whole reason this endpoint exists rather than a single flag.
 *
 * It exists to take the guessing out of the wait. Without it the worker waits
 * 15 seconds after the last sign of life before it builds the archive, because
 * a directory cannot tell "that was the last photo" from "the next one is
 * halfway up the line". The browser has never had to guess: Uppy fires
 * `complete` the instant its queue empties.
 *
 * Nothing depends on this arriving. A lost announcement costs the shortcut and
 * nothing else — the timing window still finishes the gallery, exactly as it
 * did before.
 */
import type { APIRoute } from 'astro';
import { findBySlug } from '../../../../../../server/galleries.js';
import { noteUploader } from '../../../../../../server/uploaders.js';
import { wakeWorker } from '../../../../../../server/wake.js';
import { json, readJsonBody, refuseUnlessAdmin } from '../../_admin-api';

/** Ours by way of `crypto.randomUUID()`, but it arrives from a browser. */
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const POST: APIRoute = async (context) => {
  const refusal = refuseUnlessAdmin(context);
  if (refusal) return refusal;

  const slug = String(context.params.slug ?? '');
  if (!(await findBySlug(slug))) {
    return json({ error: 'Tej galerii już nie ma. Odśwież panel.' }, 404);
  }

  const body = await readJsonBody(context.request);
  const clientId = String(body.clientId ?? '');
  const state = body.state === 'done' || body.state === 'uploading' ? body.state : null;

  if (!state || !CLIENT_ID.test(clientId)) {
    return json({ error: 'Nieprawidłowe zgłoszenie wysyłki.' }, 400);
  }

  await noteUploader(slug, clientId, state);

  // A run may already be finished by the time the last file's hook has woken
  // one, and this is the announcement that lets it stop waiting — so it gets
  // its own wake rather than relying on a run still being alive to read it.
  if (state === 'done') wakeWorker('upload finished');

  return json({ ok: true });
};
