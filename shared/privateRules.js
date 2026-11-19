/**
 * privateRules.js — private configuration supplied at runtime
 * ============================================================
 * Rule values are not in this repository. Each runtime loads one JSON document and registers it here
 * before any calculation; without it, rule-dependent calculations throw `private_rules_missing`.
 *
 *   browser dashboard   GET data/private-rules.json (behind the site gate)
 *   Netlify build       PRIVATE_RULES_JSON build variable (build.py)
 *   gp-verify function  data/private-rules.json, bundled at build time
 *   Worker              injected at release time
 *   collector / tools   file named by GP_PRIVATE_RULES_FILE
 *   tests               tests/fixtures/private-rules.synthetic.json (invented values, same shape)
 */

const SHAPE = {
  version: 'string',
  volumeDiscountTiers: 'array',
  tierCosts: 'object',
  primarySkuPrefixes: 'array',
  dropshipShipRates: 'array',
  dropshipSizeFallbackLb: 'object',
  giftSkuPatternsCalc: 'array',
  giftSkuPatternsCatalog: 'array',
  vendorAliases: 'object',
  vendorSkuPrefixes: 'array',
  vendorMinimums: 'object',
  vendorTotalMinimum: 'number',
  manualPrimaryCosts: 'array',
  manualListCosts: 'array',
  vendorFirstPaidShippingDates: 'object',
  scenarioDiscountDefaults: 'array',
  skuGrammar: 'object',
  vendorLegend: 'object',
  legacyNames: 'object',
};
// Optional here, validated where used:
//   scenarioRules               required by the scenario engine (shared/scenario.js scenarioRules())
//   scenarioAssumptionDefaults  scenario starting values
//   scenarioInputDefaults       starting values of the other scenario inputs (js/privateRules.js)

const GRAMMAR_SHAPE = {
  potPrefixes: 'array',
  otherPotPrefixes: 'array',
  wholesalePackPrefixes: 'array',
  wholesaleSinglePrefixes: 'array',
  wholesaleMarkers: 'array',
  rackPackPrefixes: 'array',
  rackPackNameOnlyPrefixes: 'array',
  size2Prefixes: 'array',
  size2ExtraPrefixes: 'array',
  size4Prefixes: 'array',
  airplantPrefixes: 'array',
  upgradeMarkers: 'array',
  randomAssortedPattern: 'string',
};

let RULES = null;
let DERIVED = null;

function typeOf(v) { return Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v; }

function deepFreeze(v) {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

/** Validates and registers the rules document. Returns the frozen rules. */
export function setPrivateRules(doc) {
  const r = typeof doc === 'string' ? JSON.parse(doc) : doc;
  if (!r || typeof r !== 'object') throw new Error('private_rules_invalid');
  for (const [k, t] of Object.entries(SHAPE)) {
    if (typeOf(r[k]) !== t) throw new Error(`private_rules_invalid:${k}`);
  }
  for (const [k, t] of Object.entries(GRAMMAR_SHAPE)) {
    if (typeOf(r.skuGrammar[k]) !== t) throw new Error(`private_rules_invalid:skuGrammar.${k}`);
  }
  for (const k of ['random_assorted', 'random_pack']) {
    if (typeof r.tierCosts[k] !== 'number') throw new Error(`private_rules_invalid:tierCosts.${k}`);
  }
  const copy = deepFreeze(JSON.parse(JSON.stringify(r)));
  RULES = copy;
  DERIVED = {
    vendorSkuPrefixes: copy.vendorSkuPrefixes.map(([src, flags, vendor]) => [new RegExp(src, flags), vendor]),
  };
  return RULES;
}

export function hasPrivateRules() { return RULES !== null; }

/** The registered rules; throws when no runtime has loaded them. */
export function privateRules() {
  if (!RULES) throw new Error('private_rules_missing');
  return RULES;
}

/** Vendor SKU-prefix rules as [RegExp, vendor] pairs. */
export function vendorSkuPrefixRules() {
  privateRules();
  return DERIVED.vendorSkuPrefixes;
}

/** Test helper: forget the registered rules. */
export function _clearPrivateRules() { RULES = null; DERIVED = null; }
