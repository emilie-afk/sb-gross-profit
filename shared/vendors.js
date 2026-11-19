/**
 * vendors.js — vendor and store codes
 * ===================================
 * The code names vendors and vendor stores by short codes only. Their full names
 * are private (the legend in the private rules, `vendorLegend`), so this public
 * repository holds no vendor names. The signed-in dashboard shows full names
 * through vendorName(); everything stored from now on carries the codes.
 *
 * Reports saved before the codes carry the full names. They are kept as they are
 * (the record of that time); readers turn a full name back into its code with
 * vendorCodeOf() so old and new weeks group together.
 *
 * Names that were part of an identifier (a setting, a stored field, a build
 * variable) have new code-based names; legacyName() gives the old one, from the
 * private rules (`legacyNames`), so values saved under it are still read.
 */
import { privateRules, hasPrivateRules } from './privateRules.js';

export const L2G = 'L2G';   // gift-box supplier
export const LG = 'LG';     // vendor tab imported as the "LG" catalog
export const LR = 'LR';     // Shopify Collective supplier (shipping passed through)
export const CC = 'CC';
export const SA = 'SA';
export const LM = 'LM';
export const HPD = 'HPD';   // house-plant dropship supplier and its two other Shopify vendor names
export const HPW = 'HPW';
export const HPS = 'HPS';
export const APS = 'APS';   // air-plant supplier

/** The vendor-scoped cost catalogs, in import order. */
export const CATALOG_VENDORS = Object.freeze([L2G, LG, CC, SA, LM]);
/** Shopify vendors that are their own store (house-plant dropship). */
export const HP_STORES = Object.freeze([HPD, HPW, HPS]);

const legend = () => (hasPrivateRules() ? privateRules().vendorLegend : {});

/** Full name of a vendor code for display; the code itself when the legend is not loaded or has no entry. */
export function vendorName(code) {
  const s = String(code ?? '');
  return legend()[s] || s;
}

/** The code of an exact full vendor name (as Shopify's Vendor column or an old report spells it); '' if none. */
export function vendorCodeOf(name) {
  const s = String(name ?? '');
  if (!s) return '';
  for (const [code, full] of Object.entries(legend())) if (full === s) return code;
  return '';
}

/** A store or vendor label as stored now: a known full name becomes its code; anything else is unchanged. */
export function toCode(label) {
  return vendorCodeOf(label) || label;
}

/** The pre-code name of an identifier (setting, stored field, build variable), or null. */
export function legacyName(name) {
  if (!hasPrivateRules()) return null;
  return privateRules().legacyNames[name] || null;
}

/** Reads `name` from an object, falling back to its pre-code name. */
export function readLegacy(obj, name) {
  if (!obj) return undefined;
  if (obj[name] !== undefined) return obj[name];
  const old = legacyName(name);
  return old ? obj[old] : undefined;
}
