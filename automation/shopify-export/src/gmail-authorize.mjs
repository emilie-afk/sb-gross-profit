#!/usr/bin/env node
/**
 * gmail-authorize.mjs — one-time Gmail read-only consent (Windows host)
 * =====================================================================
 *   node src/gmail-authorize.mjs --config config.local.json
 *
 * Installed-app OAuth with PKCE on a 127.0.0.1 loopback port. Requests ONLY
 * https://www.googleapis.com/auth/gmail.readonly. The person signs in to the
 * export mailbox in their own browser. The script then checks that Google
 * granted exactly that scope and that the authorized mailbox is the configured
 * one, and stores the refresh token in Windows Credential Manager
 * (config.gmail.credentialTarget, default sb-gmail-readonly). The token, the
 * code and the client secret are never printed or written to a file.
 *
 * The OAuth client (Desktop app) id and secret must already be in Credential
 * Manager under config.gmail.clientCredentialTarget (default sb-gmail-oauth-client).
 */
import fs from 'node:fs';
import http from 'node:http';
import crypto from 'node:crypto';
import { readWindowsCredential, writeWindowsCredential } from './credentials.mjs';
import { assertCollectorConfig, GMAIL_SCOPE } from './lib.mjs';
import { assertReadonlyScope, gmailClient, TOKEN_URL } from './gmail.mjs';

const i = process.argv.indexOf('--config');
const config = JSON.parse(fs.readFileSync(i > 0 ? process.argv[i + 1] : 'config.local.json', 'utf8'));
assertCollectorConfig(config);
const g = config.gmail;
const client = readWindowsCredential(g.clientCredentialTarget || 'sb-gmail-oauth-client');
const b64u = b => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const verifier = b64u(crypto.randomBytes(48));
const challenge = b64u(crypto.createHash('sha256').update(verifier).digest());
const state = b64u(crypto.randomBytes(24));

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const ok = u.searchParams.get('state') === state && u.searchParams.get('code');
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end(ok ? 'Authorized. You can close this window.' : 'Authorization failed.');
    server.close();
    ok ? resolve(u.searchParams.get('code')) : reject(new Error('Authorization was refused or the state did not match'));
  });
  server.listen(0, '127.0.0.1', () => {
    const redirect = `http://127.0.0.1:${server.address().port}/callback`;
    globalThis.__redirect = redirect;
    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    for (const [k, v] of Object.entries({ client_id: client.username, redirect_uri: redirect, response_type: 'code', scope: GMAIL_SCOPE,
      access_type: 'offline', prompt: 'consent', include_granted_scopes: 'false', login_hint: g.mailbox, state,
      code_challenge: challenge, code_challenge_method: 'S256' })) auth.searchParams.set(k, v);
    console.log('Open this address in a browser and sign in to the export mailbox (read-only access):\n' + auth.toString());
  });
  setTimeout(() => { server.close(); reject(new Error('Timed out after 10 minutes')); }, 10 * 60_000).unref();
});

const res = await fetch(TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: client.username,
    client_secret: client.password, redirect_uri: globalThis.__redirect }).toString() });
const j = await res.json().catch(() => ({}));
if (!res.ok || !j.refresh_token || !j.access_token) { console.error(`Google did not issue a refresh token (${res.status})`); process.exit(24); }
assertReadonlyScope(j.scope);
const box = await gmailClient({ accessToken: j.access_token }).mailbox();
if (box !== String(g.mailbox).toLowerCase()) { console.error('The authorized mailbox is not the configured export mailbox; nothing stored'); process.exit(24); }
writeWindowsCredential(g.credentialTarget || 'sb-gmail-readonly', 'gmail-readonly', j.refresh_token);
console.log('Stored the Gmail read-only authorization in Windows Credential Manager.');
