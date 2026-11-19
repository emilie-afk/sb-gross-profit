#!/usr/bin/env node
/**
 * scr-review.mjs — review Shipping Cost Report versions held by the production Worker (owner tool)
 * ================================================================================================
 *   node scr-review.mjs                       list versions waiting for review (codes and counts only)
 *   node scr-review.mjs show <scr_id>         review reasons, counts and each held/pending date's change count
 *   node scr-review.mjs accept <scr_id> "<reason>"   activate everything the version still holds (audited)
 *   node scr-review.mjs reject <scr_id> "<reason>"   reject a pending version, or only the held dates of a
 *                                                     partially accepted one (audited)
 * The admin secret is read from Windows Credential Manager (target sb-gp-admin-production, or --target)
 * and never printed. The Worker URL comes from automation/collector/config.local.json.
 * Auto-acceptance stays off: this is the review step the Worker's rules ask a person to take.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWindowsCredential } from '../../shipstation-export/src/credentials.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ti = args.indexOf('--target'); const target = ti >= 0 ? args.splice(ti, 2)[1] : 'sb-gp-admin-production';
const [cmd = 'list', id, reason] = args;
const config = JSON.parse(fs.readFileSync(path.join(here, '..', 'config.local.json'), 'utf8'));
const origin = new URL(config.workerUrl).origin;
const secret = readWindowsCredential(target).password;
const call = async (method, p, body) => {
  const r = await fetch(origin + p, { method, headers: { 'X-Admin-Secret': secret, 'Content-Type': 'application/json', 'User-Agent': 'sb-gp-scr-review/1.0' },
                                      body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${r.status} ${j.error || ''} ${String(j.message || '').slice(0, 200)}`);
  return j;
};
if (!/^(list|show|accept|reject)$/.test(cmd)) throw new Error('usage: list | show <id> | accept <id> "<reason>" | reject <id> "<reason>"');
if (cmd !== 'list' && !/^scr_[0-9a-f]{20}$/.test(id || '')) throw new Error('give a version id scr_…');
if ((cmd === 'accept' || cmd === 'reject') && !(reason && reason.trim().length >= 10)) throw new Error('give a reason (at least 10 characters); it is recorded');
if (cmd === 'list') {
  const { versions } = await call('GET', '/v1/admin/scr/versions');
  const open = versions.filter(v => v.status === 'pending_review' || (v.heldDates || []).length);
  if (!open.length) console.log('nothing waiting for review');
  for (const v of open) console.log(`${v.versionId}  ${v.status}  ${v.requestedFrom}..${v.requestedTo}  reasons=${v.reviewReasons.join('+')}  counts=${JSON.stringify(v.counts)}  held=${(v.heldDates || []).length}`);
} else if (cmd === 'show') {
  const v = await call('GET', `/v1/admin/scr/versions/${id}`);
  console.log(`${v.versionId}  ${v.status}  ${v.requestedFrom}..${v.requestedTo}  reasons=${(v.reviewReasons || []).join('+')}  counts=${JSON.stringify(v.counts)}`);
  for (const d of v.review || []) if (d.outcome !== 'identical') console.log(`  ${d.date}  ${d.outcome}  owner=${d.currentOwner ? 'yes' : 'none'}  changed orders=${(d.changes || []).length}`);
  console.log('Weeks affected:', (v.affectedWeeks || []).join(', ') || 'none yet');
} else {
  const r = await call('POST', `/v1/admin/scr/versions/${id}/${cmd}`, { reason: reason.trim() });
  console.log(`${r.versionId} ${r.status}  activated dates=${(r.activatedDates || []).length}  rejected dates=${(r.rejectedDates || []).length}`);
  console.log('Next: the scheduled task retries every 15 minutes on Monday, or run the collector task now to compute and verify.');
}
