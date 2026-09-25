/**
 * gmail.mjs — read-only Gmail access for the export email (C5)
 * ============================================================
 * Scope: https://www.googleapis.com/auth/gmail.readonly and nothing else. A
 * token whose granted scopes differ is refused before any mailbox call.
 *
 * Calls (all GET, all under users/me):
 *   profile                      the mailbox address, checked against config
 *   messages?q=<fixed search>    the fixed search from lib.mjs (never from config)
 *   messages/<id>?format=full    one candidate email, read in memory only
 *
 * The body is decoded in memory to find the single Shopify download link and
 * is then discarded: readExportMessage() returns id, time, sender, subject and
 * the candidate links only. Nothing here logs or stores a body, a token or a link.
 */
import { GMAIL_SCOPE, gmailSearchQuery, extractDownloadLinks } from './lib.mjs';

export const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me/';
const ALLOWED_PATH = /^(profile|messages\?q=[^&]+&maxResults=\d{1,2}|messages\/[A-Za-z0-9_-]{6,64}\?format=full)$/;

export class GmailError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

/** The exact scope set a token must carry. */
export function assertReadonlyScope(scopeString) {
  const got = String(scopeString || '').split(/\s+/).filter(Boolean).sort();
  if (got.length !== 1 || got[0] !== GMAIL_SCOPE) throw new GmailError('gmail_scope_not_readonly', 'The Gmail token must carry gmail.readonly and no other scope');
}

/** Refresh-token grant → short-lived access token (memory only). */
export async function gmailAccessToken({ clientId, clientSecret, refreshToken, fetchImpl = fetch }) {
  if (!clientId || !clientSecret || !refreshToken) throw new GmailError('gmail_auth_missing', 'Gmail client or refresh token is missing; run gmail-authorize');
  let res;
  try {
    res = await fetchImpl(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken }).toString() });
  } catch { throw new GmailError('gmail_network_error', 'Could not reach Google'); }
  let j = null; try { j = await res.json(); } catch { /* not JSON */ }
  if (!res.ok || !j?.access_token) throw new GmailError('gmail_auth_failed', `Google refused the refresh token (${res.status}); run gmail-authorize`);
  assertReadonlyScope(j.scope);
  return j.access_token;
}

function headerOf(payload, name) {
  const h = (payload?.headers || []).find(x => String(x.name).toLowerCase() === name.toLowerCase());
  return h ? String(h.value) : '';
}

/** Concatenate text/html and text/plain parts (base64url) in memory. Attachments are skipped. */
export function decodeBodies(payload) {
  const out = [];
  const walk = p => {
    if (!p) return;
    const mt = String(p.mimeType || '').toLowerCase();
    if ((mt === 'text/html' || mt === 'text/plain') && p.body?.data && !p.filename) {
      out.push(Buffer.from(String(p.body.data).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    }
    for (const c of p.parts || []) walk(c);
  };
  walk(payload);
  return out.join('\n');
}

export function gmailClient({ accessToken, fetchImpl = fetch }) {
  const get = async rel => {
    if (!ALLOWED_PATH.test(rel)) throw new GmailError('gmail_call_not_allowed', 'Only the profile, the fixed search and one message read are allowed');
    let res;
    try { res = await fetchImpl(API + rel, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } }); }
    catch { throw new GmailError('gmail_network_error', 'Could not reach Gmail'); }
    if (!res.ok) throw new GmailError(res.status === 401 || res.status === 403 ? 'gmail_auth_failed' : 'gmail_http_error', `Gmail answered ${res.status}`);
    return res.json();
  };
  return {
    /** The authorized mailbox address. */
    async mailbox() { return String((await get('profile')).emailAddress || '').toLowerCase(); },
    /** Message ids matching the fixed search since `requestedAt` (newest first, at most 10). */
    async searchExportMessages(requestedAt) {
      const j = await get(`messages?q=${encodeURIComponent(gmailSearchQuery(requestedAt))}&maxResults=10`);
      return (j.messages || []).map(m => String(m.id));
    },
    /** One message: metadata and candidate links only; the body never leaves this function. */
    async readExportMessage(id) {
      const m = await get(`messages/${encodeURIComponent(id)}?format=full`);
      const links = extractDownloadLinks(decodeBodies(m.payload));
      return { id: String(m.id), internalDate: Number(m.internalDate) || 0,
               from: headerOf(m.payload, 'From'), subject: headerOf(m.payload, 'Subject'), links };
    },
  };
}
