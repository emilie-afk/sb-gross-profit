/**
 * gatePage.js — the site-password sign-in page and the gate's short status pages.
 * Served by netlify/edge-functions/auth.js and auth-login.js. Every response is private and
 * never cached; messages are fixed texts (no error detail, address or configuration name).
 */
import { PRIVATE_HEADERS } from './gateSession.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const GATE_MESSAGES = Object.freeze({
  wrong_password: 'Incorrect password. Please try again.',
  locked: 'Too many attempts from this connection. Try again in 15 minutes.',
  unavailable: 'Sign-in is temporarily unavailable. Try again shortly.',
  signed_out_unrecorded: 'You are signed out on this browser. The sign-out could not be recorded on the server, so this session stays valid elsewhere until it expires (at most 8 hours).',
});

export function loginPage(message = '', status = 200, extraHeaders = {}) {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>GP Dashboard — Sign In</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #0f172a;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }
    .card {
      background: #1e293b;
      border: 1px solid #334155;
      border-radius: 12px;
      padding: 40px;
      width: 100%;
      max-width: 380px;
      box-shadow: 0 25px 50px rgba(0,0,0,0.5);
    }
    .logo {
      text-align: center;
      margin-bottom: 28px;
    }
    .logo svg { width: 40px; height: 40px; color: #6ee7b7; }
    h1 { font-size: 1.25rem; font-weight: 600; color: #f1f5f9; text-align: center; margin-bottom: 6px; }
    p  { font-size: 0.85rem; color: #94a3b8; text-align: center; margin-bottom: 24px; }
    label { display: block; font-size: 0.8rem; font-weight: 500; color: #cbd5e1; margin-bottom: 6px; }
    input[type=password] {
      width: 100%;
      padding: 10px 14px;
      background: #0f172a;
      border: 1px solid #334155;
      border-radius: 8px;
      color: #f1f5f9;
      font-size: 0.95rem;
      outline: none;
      transition: border-color .2s;
    }
    input[type=password]:focus { border-color: #6ee7b7; }
    .error {
      margin-top: 10px;
      padding: 8px 12px;
      background: #450a0a;
      border: 1px solid #7f1d1d;
      border-radius: 6px;
      color: #fca5a5;
      font-size: 0.8rem;
    }
    button {
      margin-top: 20px;
      width: 100%;
      padding: 11px;
      background: #6ee7b7;
      color: #0f172a;
      border: none;
      border-radius: 8px;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      transition: background .2s;
    }
    button:hover { background: #34d399; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
      </svg>
    </div>
    <h1>GP Dashboard</h1>
    <p>Succulents Box Analytics</p>
    <form method="POST" action="/__auth">
      <label for="pw">Password</label>
      <input type="password" id="pw" name="password" placeholder="Enter password" autofocus autocomplete="current-password">
      ${message ? `<div class="error" role="alert">${esc(message)}</div>` : ''}
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...PRIVATE_HEADERS, ...extraHeaders } });
}

/** A plain service-unavailable answer: the gate is not configured or cannot reach the Worker. Nothing is opened. */
export const unavailable = () => loginPage(GATE_MESSAGES.unavailable, 503, { 'Retry-After': '60' });
