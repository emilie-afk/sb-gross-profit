/**
 * pyCompat.js — the few Python behaviours build.py's cost tables depend on
 * =======================================================================
 * The Worker rebuilds the dashboard's cost catalog from the same sheets as
 * build.py. To produce identical tables it must read CSV, trim text, parse
 * numbers and round exactly as CPython does:
 *
 *   pyCsvRows(text)      csv.reader(io.StringIO(text)), excel dialect, strict=False
 *   pyDictRows(text)     csv.DictReader over the same (blank rows skipped, restval None)
 *   pyStrip / PY_WS      str.strip() and the regex \s class (str.isspace characters)
 *   pyFloat(s)           float(s) for ASCII input (underscores, inf, nan)
 *   pyRound(x, n)        round(x, n): correctly rounded, ties to even
 *
 * Where CPython would raise (a lone CR inside an unquoted field, a NUL), these
 * throw PyCompatError; the Worker treats that source as failed.
 */
export class PyCompatError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// str.isspace() characters (CPython Py_UNICODE_ISSPACE). JS \s differs: it adds
// U+FEFF and lacks U+001C–U+001F and U+0085.
const WS_CHARS = '\\t\\n\\x0b\\x0c\\r\\x1c\\x1d\\x1e\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
export const PY_WS = WS_CHARS;
const LEAD = new RegExp(`^[${WS_CHARS}]+`), TRAIL = new RegExp(`[${WS_CHARS}]+$`);
export const pyStrip = s => String(s).replace(LEAD, '').replace(TRAIL, '');

/** csv.reader over io.StringIO(text): lines split on '\n' only, CR handled by the parser. */
export function pyCsvRows(text) {
  const s = String(text);
  if (s.includes('\0')) throw new PyCompatError('csv_nul', 'line contains NUL');
  const out = [];
  let fields = [], field = '', fieldLen = 0, state = 'START_RECORD';
  const save = () => { fields.push(field); field = ''; fieldLen = 0; };
  const add = c => { field += c; fieldLen++; };
  const EOL = null;
  const proc = c => {
    switch (state) {
      case 'START_RECORD':
        if (c === EOL) return;
        if (c === '\n' || c === '\r') { state = 'EAT_CRNL'; return; }
        state = 'START_FIELD';
        // falls through
      case 'START_FIELD':
        if (c === '\n' || c === '\r' || c === EOL) { save(); state = c === EOL ? 'START_RECORD' : 'EAT_CRNL'; }
        else if (c === '"') state = 'IN_QUOTED_FIELD';
        else if (c === ',') save();
        else { add(c); state = 'IN_FIELD'; }
        return;
      case 'IN_FIELD':
        if (c === '\n' || c === '\r' || c === EOL) { save(); state = c === EOL ? 'START_RECORD' : 'EAT_CRNL'; }
        else if (c === ',') { save(); state = 'START_FIELD'; }
        else add(c);
        return;
      case 'IN_QUOTED_FIELD':
        if (c === EOL) return;
        if (c === '"') state = 'QUOTE_IN_QUOTED_FIELD';
        else add(c);
        return;
      case 'QUOTE_IN_QUOTED_FIELD':
        if (c === '"') { add(c); state = 'IN_QUOTED_FIELD'; }
        else if (c === ',') { save(); state = 'START_FIELD'; }
        else if (c === '\n' || c === '\r' || c === EOL) { save(); state = c === EOL ? 'START_RECORD' : 'EAT_CRNL'; }
        else { add(c); state = 'IN_FIELD'; }                 // strict=False
        return;
      case 'EAT_CRNL':
        if (c === '\n' || c === '\r') return;
        if (c === EOL) { state = 'START_RECORD'; return; }
        throw new PyCompatError('csv_newline_in_field', 'new-line character seen in unquoted field');
    }
  };
  // io.StringIO iteration: each line keeps its trailing '\n'.
  const lines = [];
  for (let i = 0; i < s.length;) { const j = s.indexOf('\n', i); if (j < 0) { lines.push(s.slice(i)); break; } lines.push(s.slice(i, j + 1)); i = j + 1; }
  for (const line of lines) {
    for (const c of line) proc(c);
    proc(EOL);
    if (state === 'START_RECORD') { out.push(fields); fields = []; }
  }
  if (fieldLen !== 0 || state === 'IN_QUOTED_FIELD') { save(); out.push(fields); }   // EOF inside a record, strict=False
  return out;
}

/**
 * csv.DictReader: the first row is the header; empty rows are skipped; missing
 * trailing values are null (restval None); extra values go under key null.
 * Returned as Maps so duplicate header names behave like a Python dict.
 */
export function pyDictRows(text) {
  const rows = pyCsvRows(text);
  if (!rows.length) return [];
  const header = rows[0], out = [];
  for (const row of rows.slice(1)) {
    if (row.length === 0) continue;
    const d = new Map();
    for (let i = 0; i < Math.min(header.length, row.length); i++) d.set(header[i], row[i]);
    if (header.length < row.length) d.set(null, row.slice(header.length));
    else for (const k of header.slice(row.length)) d.set(k, null);
    out.push(d);
  }
  return out;
}

/** dict(zip(header, row)) */
export function pyZipDict(header, row) {
  const d = new Map();
  for (let i = 0; i < Math.min(header.length, row.length); i++) d.set(header[i], row[i]);
  return d;
}

/** dict.get(k, dflt) */
export const pyGet = (d, k, dflt = undefined) => (d.has(k) ? d.get(k) : dflt);

/** Python truthiness for the values these tables handle. */
export const pyTruthy = v => !(v === null || v === undefined || v === '' || v === 0 || v === false || (typeof v === 'number' && v === 0));

/** `a or b or c` */
export const pyOr = (...vals) => { for (const v of vals) if (pyTruthy(v)) return v; return vals[vals.length - 1]; };

/** str.strip() that raises on None, as CPython does. */
export function pyStripStr(v) {
  if (typeof v !== 'string') throw new PyCompatError('none_value', "'NoneType' object has no attribute 'strip'");
  return pyStrip(v);
}

const FLOAT_RE = /^[+-]?(?:(?:\d(?:_?\d)*)(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;
const SPECIAL_RE = /^([+-]?)(inf|infinity|nan)$/i;
/** float(s) → number, or null where CPython raises ValueError. ASCII digits only. */
export function pyFloat(s) {
  const t = pyStrip(String(s));
  const sp = t.match(SPECIAL_RE);
  if (sp) return sp[2].toLowerCase() === 'nan' ? NaN : (sp[1] === '-' ? -Infinity : Infinity);
  if (!FLOAT_RE.test(t)) return null;
  return Number(t.replace(/_/g, ''));
}

/** round(x, n) for finite x: exact decimal expansion, ties to even (CPython float.__round__). */
export function pyRound(x, n) {
  if (!Number.isFinite(x) || x === 0) return x;
  if (Math.abs(x) >= 1e15) return x;
  const neg = x < 0;
  const exact = Math.abs(x).toFixed(100);                // exact for the magnitudes costs take
  const [ip, fp] = exact.split('.');
  const keep = fp.slice(0, n), rest = fp.slice(n);
  let digits = BigInt(ip + keep);
  const first = rest[0], tail = rest.slice(1);
  const roundUp = first > '5' || (first === '5' && (/[1-9]/.test(tail) || (digits % 2n === 1n)));
  if (roundUp) digits += 1n;
  const str = digits.toString().padStart(n + 1, '0');
  const v = Number(`${str.slice(0, str.length - n)}.${str.slice(str.length - n)}`);
  return neg ? -v : v;
}
