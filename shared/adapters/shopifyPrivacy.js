/**
 * shopifyPrivacy.js — minimum free-text form of the Shopify orders export
 * ======================================================================
 * The Shopify orders export carries free text in columns the engine needs:
 * Tags, Discount Code, Source, Note Attributes and Lineitem name. The real
 * Jul–Sep export showed marketplace order ids and email/phone/URL-like text in
 * Tags, and session tokens, cart ids and UTM URLs in Note Attributes.
 *
 * The engine only ever reads (shared/calculator.js, inventory 2026-09-24):
 *   Tags            → contains 'sample' / 'influencer'           (influencer detection)
 *   Discount Code   → contains 'sample' / 'influencer'           (influencer detection)
 *   Source          → channel label via normalizeChannel; 'tiktok' with a $0 total
 *   Note Attributes → 'Channel: <x>' (channel label) and the text 'free sample'
 *   Lineitem name   → Route / digital / pack detection, name matching, display
 *
 * reduceShopifyOrderRows() keeps exactly that on the Windows machine, before
 * anything is uploaded. assertReducedShopifyOrderRows() is the Worker's
 * independent check: anything outside the reduced form rejects the upload.
 * assertReducedNormalizedOrders() applies the same contract to the manual /
 * backfill `normalized` path, so no path bypasses it.
 *
 * An unapproved Source or Channel value is never silently relabelled: the
 * collector refuses the file (sanitization_failed) so the list can be extended
 * deliberately. Parity: engine output on reduced rows equals engine output on
 * the raw rows (tests/shopify-privacy.test.mjs; verified locally on the real
 * Jul–Sep export: 0 field differences across 8,954 engine lines).
 */
import { CustomerDataError } from '../normalized.js';
import { SHOPIFY_ORDERS_CSV_COLUMNS } from './shopifyCsv.js';

/** Tags kept (compared lower-case). Subscription tags are classification evidence. */
export const APPROVED_TAGS = Object.freeze([
  'free sample', 'sample', 'influencer', 'prepaid', 'subscription',
  'subscription recurring order', 'subscription first order',
]);
/** Words derived from Discount Code; the raw code is never uploaded. */
export const DISCOUNT_TOKENS = Object.freeze(['sample', 'influencer']);
/** Every Source value seen in the Jul 1–Sep 21 export. Extend deliberately. */
export const APPROVED_SOURCES = Object.freeze([
  '', 'web', '294517', 'sellbrite', 'subscription_contract_checkout_one', '2329312', '205641',
  '3890849', 'tiktok', 'shopify_draft_order', 'shopify-collective-automatic-payments', '294412976129',
]);
/** Channel values the engine maps (Note Attributes "Channel: x"), compared lower-case. */
export const APPROVED_CHANNELS = Object.freeze([
  'amazon', 'facebook', 'instagram', 'tiktok', 'walmart', 'ebay', 'etsy', 'google', 'google shopping', 'pos', 'web',
]);
const NOTE_KEYS = new Set(['channel', 'free sample']);
const MONEY = /^\$?\d{1,6}(\.\d{1,2})?$/;

const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/;
const URL_RE = /https?:\/\/|www\./i;
// Needs separators, so product numbers and 12-digit app ids are not mistaken for phones.
const PHONE = /(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;
export const looksPersonal = s => EMAIL.test(s) || URL_RE.test(s) || PHONE.test(s);

const NOTE_COLUMNS = ['Note Attributes', 'Note attributes'];
const SOURCE_COLUMNS = ['Source', 'Source name'];

function noteLines(text) {
  return String(text ?? '').split(/\r?\n/).map(l => {
    const i = l.indexOf(':');
    return i < 0 ? (l.trim() ? { key: l.trim(), value: '' } : null) : { key: l.slice(0, i).trim(), value: l.slice(i + 1).trim() };
  }).filter(Boolean);
}
const okNote = ({ key, value }) => {
  const k = key.toLowerCase();
  if (k === 'channel') return APPROVED_CHANNELS.includes(value.toLowerCase());
  if (k === 'free sample') return MONEY.test(value);
  return false;
};
const reduceTags = t => String(t ?? '').split(',').map(x => x.trim()).filter(x => APPROVED_TAGS.includes(x.toLowerCase())).join(', ');
const reduceCode = c => { const s = String(c ?? '').toLowerCase(); return DISCOUNT_TOKENS.filter(w => s.includes(w)).join(' '); };

/**
 * Windows side. `rows` already hold only allowlisted columns (sanitizeShopifyOrderRows).
 * Returns { rows, problems }. A non-empty `problems` means the file must not be uploaded.
 * Problems name the column and the rule, never the value.
 */
export function reduceShopifyOrderRows(rows) {
  const problems = [];
  const out = rows.map((r, i) => {
    const o = { ...r };
    if ('Tags' in o) o['Tags'] = reduceTags(o['Tags']);
    if ('Discount Code' in o) o['Discount Code'] = reduceCode(o['Discount Code']);
    for (const c of NOTE_COLUMNS) {
      if (!(c in o)) continue;
      const kept = noteLines(o[c]).filter(a => NOTE_KEYS.has(a.key.toLowerCase()));
      for (const a of kept) if (!okNote(a)) problems.push({ row: i, column: c, rule: `unapproved ${a.key.toLowerCase()} value` });
      o[c] = kept.filter(okNote).map(a => `${a.key}: ${a.value}`).join('\n');
    }
    for (const c of SOURCE_COLUMNS) if (c in o && !APPROVED_SOURCES.includes(String(o[c]).trim())) problems.push({ row: i, column: c, rule: 'unapproved source value' });
    if (looksPersonal(String(o['Lineitem name'] ?? ''))) problems.push({ row: i, column: 'Lineitem name', rule: 'looks like personal data' });
    return o;
  });
  return { rows: out, problems };
}

/** Worker side: the upload must already be in the reduced form. */
export function assertReducedShopifyOrderRows(rows) {
  const paths = [];
  const allowed = new Set(SHOPIFY_ORDERS_CSV_COLUMNS);
  const headers = rows.length ? Object.keys(rows[0]) : [];
  for (const h of headers) if (!allowed.has(h)) paths.push(`$.columns.${h}`);
  rows.forEach((r, i) => {
    if (r['Tags'] && r['Tags'] !== reduceTags(r['Tags'])) paths.push(`$[${i}].Tags`);
    if (r['Discount Code'] && r['Discount Code'] !== reduceCode(r['Discount Code'])) paths.push(`$[${i}].Discount Code`);
    for (const c of NOTE_COLUMNS) for (const a of noteLines(r[c])) if (!NOTE_KEYS.has(a.key.toLowerCase()) || !okNote(a)) paths.push(`$[${i}].${c}.${a.key}`);
    if (looksPersonal(String(r['Lineitem name'] ?? ''))) paths.push(`$[${i}].Lineitem name`);
  });
  if (paths.length) throw new CustomerDataError(paths);
  const badSource = rows.findIndex(r => SOURCE_COLUMNS.some(c => c in r && !APPROVED_SOURCES.includes(String(r[c]).trim())));
  if (badSource >= 0) {
    const e = new Error(`Row ${badSource}: Source is not on the approved list; extend APPROVED_SOURCES deliberately`);
    e.code = 'unapproved_value';
    throw e;
  }
}

/** Manual / backfill `normalized` path: same contract on normalized orders. */
export function assertReducedNormalizedOrders(orders) {
  const paths = [];
  orders.forEach((o, i) => {
    for (const t of o.tags || []) if (!APPROVED_TAGS.includes(String(t).toLowerCase())) paths.push(`$[${i}].tags`);
    for (const c of o.discountCodes || []) if (String(c) !== reduceCode(c) || !String(c)) paths.push(`$[${i}].discountCodes`);
    for (const a of o.noteAttributes || []) if (!NOTE_KEYS.has(String(a.key).toLowerCase()) || !okNote({ key: String(a.key), value: String(a.value ?? '') })) paths.push(`$[${i}].noteAttributes.${a.key}`);
    for (const l of o.lines || []) if (looksPersonal(String(l.productName ?? ''))) paths.push(`$[${i}].lines.productName`);
  });
  if (paths.length) throw new CustomerDataError([...new Set(paths)]);
  const bad = orders.findIndex(o => !APPROVED_SOURCES.includes(String(o.sourceName ?? '').trim()));
  if (bad >= 0) { const e = new Error(`Order ${bad}: sourceName is not on the approved list`); e.code = 'unapproved_value'; throw e; }
}
