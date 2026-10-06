/**
 * redact.mjs — keep credentials out of everything the collectors write or print
 * ============================================================================
 * Every value read from Windows Credential Manager is registered here at the moment it is read
 * (credentials.mjs). Run records and console output pass through scrub(), which replaces each
 * registered value, in plain, JSON-escaped and URL-encoded form, with <redacted>. serializeRecord()
 * scrubs a run record and refuses to return text that still holds a registered value, so a typed
 * credential cannot reach a run record whatever field or error message carries it.
 */
import fs from 'node:fs';

const SECRETS = new Set();
/** Register a credential value (values shorter than 4 characters are not secrets worth matching). */
export function registerSecret(value) { if (typeof value === 'string' && value.length >= 4) SECRETS.add(value); }
const forms = v => [...new Set([v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)])].filter(Boolean);
/** Text with every registered value replaced by <redacted>. */
export function scrub(text) {
  let t = String(text ?? '');
  for (const s of SECRETS) for (const f of forms(s)) if (t.includes(f)) t = t.split(f).join('<redacted>');
  return t;
}
/** True when `text` still holds a registered value in any form. */
export const holdsSecret = text => [...SECRETS].some(s => forms(s).some(f => String(text).includes(f)));
/** JSON text of a run record with every registered value removed (throws if one survived). */
export function serializeRecord(record) {
  const t = scrub(JSON.stringify(record, null, 2));
  if (holdsSecret(t)) throw new Error('A run record still held a credential after redaction; it was not written');
  return t;
}
/**
 * Write a run record. Every registered credential value is removed first; if one would survive,
 * a minimal record (codes only) is written instead.
 */
export function writeRunRecord(file, record, fsImpl = fs) {
  let text;
  try { text = serializeRecord(record); }
  catch { text = JSON.stringify({ runId: record.runId, kind: record.kind, status: record.status, exitCode: record.exitCode ?? null, redacted: true }, null, 2); }
  fsImpl.writeFileSync(file, text);
}
/**
 * A run record's error text: the first line only, URLs masked. Playwright's "Call log" (which can
 * repeat the arguments of fill(), i.e. a typed password) and quoted arguments are never kept.
 */
export const safeError = e => scrub(String(e?.message ?? e ?? '')).split('\n')[0].replace(/https?:\/\/\S+/g, '<url>')
  .replace(/(fill|type|press|pressSequentially)\((["'`]).*?\2\)/g, '$1(<redacted>)').slice(0, 200);
/** Tests only. */
export const _clearSecrets = () => SECRETS.clear();
