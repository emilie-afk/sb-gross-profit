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
    .logo img { display: block; width: 120px; height: auto; margin: 0 auto; }
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
      <img src="data:image/png;base64,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" alt="Succulents Box" width="120" height="14">
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
