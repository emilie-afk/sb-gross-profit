/**
 * actor.js — who did it, as far as the Worker can actually tell
 * =============================================================
 * `actor_class` is assigned by the SERVER from the authentication path of the
 * request. It is the only actor value the audit trail vouches for:
 *
 *   admin_secret    a caller holding X-Admin-Secret (an operator or an admin script —
 *                   the shared secret cannot tell them apart)
 *   ingest_secret   a caller holding X-Ingest-Secret (Windows collector, build.py, backfill)
 *   reader_session  a signed-in dashboard session (reads only today)
 *   worker          the Worker itself (state changes it makes on its own)
 *   migration       a D1 migration
 *
 * `actor_label` is an OPTIONAL, caller-supplied operational tag (e.g. "collector"
 * or "duc"). It is stored for context only and is NOT verified identity.
 * Labels are short and may not contain an email address.
 */
import { ApiError } from './http.js';

export const ACTOR_CLASSES = Object.freeze(['admin_secret', 'ingest_secret', 'reader_session', 'worker', 'migration']);
export const WORKER = Object.freeze({ cls: 'worker', label: null });

const LABEL_RE = /^[\w .:\-/]{1,64}$/;

/** Validate an optional caller-supplied label. */
export function actorLabel(v) {
  if (v === undefined || v === null || v === '') return null;
  const s = String(v).trim();
  if (!LABEL_RE.test(s) || s.includes('@')) {
    throw new ApiError(400, 'bad_payload', 'actorLabel must be 1–64 letters, digits, space or . : - / _ (no email addresses)');
  }
  return s;
}

/** Actor for a request, from its authentication path plus an optional label. */
export function actorFor(cls, body = {}) {
  if (!ACTOR_CLASSES.includes(cls)) throw new Error(`unknown actor class ${cls}`);
  if (body && body.actor !== undefined) {
    throw new ApiError(400, 'bad_payload', "'actor' is not accepted; the actor class comes from authentication. Use optional 'actorLabel' (unverified).");
  }
  return Object.freeze({ cls, label: actorLabel(body?.actorLabel) });
}

export const actorJson = a => ({ actorClass: a.cls, actorLabel: a.label });
