/**
 * collect.mjs — one weekly Shopify collection, with every dependency injected
 * ===========================================================================
 * export.mjs wires in Playwright, Windows Credential Manager, Gmail and the
 * Worker upload; tests wire in fakes. The order of operations is:
 *
 *   1. Gmail preflight: read-only token (scope checked) and the mailbox address
 *      must match config — before anything is requested from Shopify.
 *   2. Shopify Admin: classify the page; sign in from Credential Manager only on
 *      a plain login form; stop on 2FA, captcha, expired session that login
 *      does not fix, or any unknown page.
 *   3. Run the recorded export steps (rolling eight-week window). A small
 *      export may download directly; otherwise Shopify emails a link.
 *   4. Poll the fixed Gmail search until exactly one matching email with one
 *      Shopify download link arrives (timeout → stop; two → stop).
 *   5. Download into memory, check it is a Shopify orders CSV, sanitize at once
 *      (raw bytes are zeroed and never written to disk).
 *   6. Upload the sanitized CSV (mode 'rolling'); on failure keep only the
 *      sanitized file in quarantine (72 h).
 *   7. Write the run manifest: hashes, window, counts, statuses — never a row,
 *      a link, an email header or body, a token or a secret.
 */
import crypto from 'node:crypto';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { EXIT, KIND, rollingWindow, prepareShopifyExport, selectExportMessage, detectExportFormat, safeError, hostAllowed } from './lib.mjs';
import { NEEDS_HUMAN } from './authState.mjs';

const hash16 = s => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);

/**
 * @param {object} d
 * @param {object} d.config        validated collector config
 * @param {object} d.week          { weekStart, weekEnd, weekStartUS, weekEndUS }
 * @param {object} d.paths         localPaths(config)
 * @param {string} d.runId
 * @param {() => Promise<object>} d.gmailClient  read-only client (throws GmailError)
 * @param {object} d.browser       { open, authState, login, runSteps, fetchDownload, close }
 * @param {(target: string) => { username, password }} d.credential
 * @param {(payload: object) => Promise<object>} d.upload
 * @param {() => Date} [d.now]
 * @param {(ms: number) => Promise<void>} [d.sleep]
 * @param {() => Promise<string>} [d.onWaiting]  C7: called once after the export is requested, before the Gmail wait
 */
export async function runCollector(d) {
  const { config, week, paths, runId, browser } = d;
  const fs = d.fs || nodeFs;
  const now = d.now || (() => new Date());
  const sleep = d.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const win = rollingWindow(week);
  const gcfg = { pollSeconds: config.gmail?.pollSeconds ?? 60, timeoutMinutes: config.gmail?.timeoutMinutes ?? 45 };
  const manifest = { runId, kind: KIND, weekStart: week.weekStart, weekEnd: week.weekEnd, windowFrom: win.from, windowTo: win.to,
                     startedAt: now().toISOString(), status: 'running' };
  const finish = (status, exitCode, extra = {}) => {
    Object.assign(manifest, { status, exitCode, finishedAt: now().toISOString(), ...extra });
    fs.mkdirSync(paths.runs, { recursive: true });
    fs.writeFileSync(nodePath.join(paths.runs, `${runId}.json`), JSON.stringify(manifest, null, 2));
    return manifest;
  };

  // 1. Gmail preflight
  let gmail;
  try {
    gmail = await d.gmailClient();
    const box = await gmail.mailbox();
    if (box !== String(config.gmail.mailbox).toLowerCase()) return finish('gmail_mailbox_mismatch', EXIT.GMAIL_AUTH);
    manifest.mailboxVerified = true;
  } catch (e) {
    return finish(e.code || 'gmail_auth_failed', EXIT.GMAIL_AUTH, { error: safeError(e) });
  }

  let opened = false;
  try {
    // 2. Shopify Admin sign-in state
    await browser.open(); opened = true;
    let { state, evidence } = await browser.authState();
    manifest.authStateAtStart = state;
    if (state === 'login_required' || state === 'session_expired') {
      await browser.login(d.credential(config.credentialTarget || 'sb-shopify-export'));
      ({ state, evidence } = await browser.authState());
      if (state === 'login_required') return finish('login_failed', EXIT.LOGIN_FAILED);
    }
    if (state === 'two_factor_required') return finish('needs_2fa', EXIT.NEEDS_2FA, { note: 'Run npm run login once in a visible browser' });
    if (state === 'captcha') return finish('needs_human_captcha', EXIT.CAPTCHA);
    if (NEEDS_HUMAN.has(state) || state !== 'authenticated') return finish('unknown_page', EXIT.UNKNOWN_PAGE, { evidence });

    // 3. Request the export
    const requestedAt = now().toISOString();
    manifest.requestedAt = requestedAt;
    const vars = { ...week, windowFrom: win.from, windowTo: win.to, windowFromUS: win.fromUS, windowToUS: win.toUS };
    let stepResult;
    try { stepResult = await browser.runSteps(config.exportSteps || [], vars); }
    catch (e) { return finish('export_steps_failed', EXIT.EXPORT_FAILED, { error: safeError(e) }); }

    // 4. The file: direct download, or the emailed link
    let file = null;
    if (stepResult?.download) {
      file = { status: 200, contentType: '', body: stepResult.download, via: 'direct_download' };
    } else {
      // C7: while Shopify prepares the emailed export, the orchestrator uploads
      // any ready ShipStation result (HTTP only; no second browser).
      if (d.onWaiting) { try { manifest.whileWaiting = (await d.onWaiting()) || 'done'; } catch (e) { manifest.whileWaiting = `error: ${safeError(e)}`; } }
      const deadline = Date.parse(requestedAt) + gcfg.timeoutMinutes * 60_000;
      const seen = new Map();
      let link = null, polls = 0;
      while (!link) {
        polls++;
        let ids;
        try { ids = await gmail.searchExportMessages(requestedAt); }
        catch (e) { return finish(e.code || 'gmail_error', EXIT.GMAIL_AUTH, { error: safeError(e), polls }); }
        for (const id of ids) if (!seen.has(id)) {
          try { seen.set(id, await gmail.readExportMessage(id)); }
          catch (e) { return finish(e.code || 'gmail_error', EXIT.GMAIL_AUTH, { error: safeError(e), polls }); }
        }
        const pick = selectExportMessage([...seen.values()], { requestedAt });
        if (pick.status === 'ambiguous') return finish('export_email_ambiguous', EXIT.EXPORT_FAILED, { candidates: pick.count, polls });
        if (pick.status === 'found') {
          link = pick.link;
          manifest.email = { messageIdSha256: hash16(pick.message.id), receivedAt: new Date(pick.message.internalDate).toISOString(), polls };
          break;
        }
        if (now().getTime() + gcfg.pollSeconds * 1000 > deadline) return finish('export_email_timeout', EXIT.EMAIL_TIMEOUT, { polls, waitedMinutes: gcfg.timeoutMinutes });
        await sleep(gcfg.pollSeconds * 1000);
      }
      const host = new URL(link).hostname;
      if (!hostAllowed(host)) return finish('unknown_export_link', EXIT.EXPORT_FAILED, { downloadHost: host });
      manifest.downloadHost = host;
      try { file = { ...(await browser.fetchDownload(link)), via: 'email_link' }; }
      catch (e) { return finish('download_failed', EXIT.EXPORT_FAILED, { error: safeError(e) }); }
      link = null;
    }
    if (file.finalHost) manifest.downloadFinalHost = file.finalHost;
    if (file.status !== 200) return finish('download_failed', EXIT.EXPORT_FAILED, { httpStatus: file.status });
    const format = detectExportFormat(file.body, file.contentType);
    manifest.download = { via: file.via, bytes: file.body.length, format };
    if (format === 'html') { file.body.fill(0); return finish('download_requires_login', EXIT.EXPORT_FAILED); }
    if (format !== 'shopify_orders_csv') { file.body.fill(0); return finish('unknown_export_format', EXIT.EXPORT_FAILED, { format }); }

    // 5. Sanitize in memory; the raw bytes are zeroed right after
    const exportedAt = now().toISOString();
    const prep = prepareShopifyExport(file.body.toString('utf8'), { week, exportedAt });
    file.body.fill(0); file = null;
    if (prep.refused) return finish(prep.refused, EXIT.EXPORT_FAILED, { reason: prep.reason, ...(prep.detail ? { detail: prep.detail } : {}) });
    Object.assign(manifest, { exportedAt, facts: prep.facts });

    // 6. Upload
    const ingest = await d.upload(prep.payload);
    if (!ingest.ok) {
      const name = `${KIND}_${week.weekStart}_${runId}.csv`;
      fs.mkdirSync(paths.quarantine, { recursive: true });
      fs.writeFileSync(nodePath.join(paths.quarantine, name), prep.sanitizedText);          // sanitized only; purged after 72 h
      return finish('upload_failed', EXIT.UPLOAD_FAILED, { ingest, quarantined: name });
    }
    return finish('ok', EXIT.OK, { ingest });
  } catch (e) {
    return finish('export_failed', EXIT.EXPORT_FAILED, { error: safeError(e) });
  } finally {
    if (opened) { try { await browser.close(); } catch { /* ignore */ } }
  }
}
