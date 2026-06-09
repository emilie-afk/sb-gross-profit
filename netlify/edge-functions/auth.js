/**
 * Netlify Edge Function — Password Gate
 * Runs on every request. Without a valid session cookie, only the
 * login page is returned. No site assets or data are accessible.
 *
 * Set SITE_PASSWORD in Netlify → Site configuration → Environment variables.
 */

const COOKIE_NAME = '__gp_session';
const COOKIE_MAX_AGE = 60 * 60 * 8; // 8 hours

async function sha256(str) {
  const data = new TextEncoder().encode(str);
  const buf  = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function getCookie(req, name) {
  const header = req.headers.get('cookie') || '';
  const match  = header.split(';').find(c => c.trim().startsWith(name + '='));
  return match ? match.split('=').slice(1).join('=').trim() : null;
}

function loginPage(error = '') {
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
      ${error ? `<div class="error">${error}</div>` : ''}
      <button type="submit">Sign In</button>
    </form>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  });
}

/**
 * Cost data files (data/*.json) are written by build.py at deploy time
 * and served as normal static assets — gated by this auth function.
 *
 * Required Netlify env var : SITE_PASSWORD
 * HP fallback env vars     : PRODUCT_COSTS_JSON1, PRODUCT_COSTS_JSON2, SKU_WEIGHTS_JSON
 *   (only needed if the HP Dropship Google Sheet is not yet populated)
 */

export default async function handler(req, context) {
  const sitePassword = Deno.env.get('SITE_PASSWORD');

  // No password configured — block everything with a clear message
  if (!sitePassword) {
    return new Response('SITE_PASSWORD environment variable not set.', { status: 503 });
  }

  const url = new URL(req.url);

  // Handle login POST
  if (req.method === 'POST' && url.pathname === '/__auth') {
    let body = '';
    try { body = await req.text(); } catch {}
    const params   = new URLSearchParams(body);
    const entered  = params.get('password') || '';
    const redirect = params.get('redirect') || '/';

    if (entered === sitePassword) {
      const token = await sha256(sitePassword + Date.now().toString().slice(0, -3));
      // Store token → password hash mapping via cookie value = sha256(password)
      // (No server state needed — we re-derive the expected hash on each request)
      const cookieVal = await sha256(sitePassword);
      return new Response(null, {
        status: 302,
        headers: {
          'Location': redirect.startsWith('/') ? redirect : '/',
          'Set-Cookie': `${COOKIE_NAME}=${cookieVal}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`
        }
      });
    }
    return loginPage('Incorrect password. Please try again.');
  }

  // Logout
  if (url.pathname === '/__logout') {
    return new Response(null, {
      status: 302,
      headers: {
        'Location': '/',
        'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
      }
    });
  }

  // Validate session cookie on all other requests
  const cookieVal   = getCookie(req, COOKIE_NAME);
  const expectedVal = await sha256(sitePassword);

  if (cookieVal === expectedVal) {
    return context.next(); // Authenticated — serve the file
  }

  // Not authenticated — return login page (nothing else leaks)
  return loginPage();
}

export const config = { path: '/*' };
