"""
private_rules.py — loads the private business rules for build.py
=================================================================
PRIVATE_RULES_JSON holds the confidential rules (plain JSON, or 'gz:' + base64 of the gzipped JSON) (supplier costs, discount tiers, rate cards,
SKU and vendor mapping rules); shared/privateRules.js documents the shape. Nothing here
prints a value: only key names and counts.

  production / staging build  → required; copied to data/private-rules.json, which the
                                 dashboard reads behind the site gate and netlify.toml bundles
                                 into gp-verify. Missing or invalid → the build fails.
  restricted build (previews)  → deploy_context.py removed the variable; nothing is written.
  local run                    → optional (parity tools pass it explicitly).
"""
import base64, gzip, json, os

REQUIRED = ('version', 'volumeDiscountTiers', 'tierCosts', 'primarySkuPrefixes', 'dropshipShipRates',
            'dropshipSizeFallbackLb', 'giftSkuPatternsCalc', 'giftSkuPatternsCatalog', 'vendorAliases',
            'vendorSkuPrefixes', 'vendorMinimums', 'vendorTotalMinimum', 'manualPrimaryCosts',
            'manualListCosts', 'vendorFirstPaidShippingDates', 'scenarioDiscountDefaults', 'skuGrammar', 'vendorLegend', 'legacyNames')
ROOT = os.path.dirname(os.path.abspath(__file__))
OUTPUTS = (os.path.join(ROOT, 'data', 'private-rules.json'),)   # also bundled into gp-verify (netlify.toml)


def decode(raw):
    """The variable holds the JSON itself, or 'gz:' + base64(gzip(JSON)) to fit Netlify's value size limit."""
    raw = raw.strip()
    if raw.startswith('gz:'):
        return gzip.decompress(base64.b64decode(raw[3:])).decode('utf-8')
    return raw


def parse(raw):
    doc = json.loads(decode(raw))
    missing = [k for k in REQUIRED if k not in doc]
    if missing:
        raise ValueError('PRIVATE_RULES_JSON is missing: ' + ', '.join(missing))
    return doc


def load(environ, role):
    raw = (environ.get('PRIVATE_RULES_JSON') or '').strip()
    if not raw:
        if role in ('production', 'staging'):
            raise SystemExit('[private rules] PRIVATE_RULES_JSON is not set: refusing to build a dashboard '
                             'whose calculations would not match the Worker and the verifier.')
        print('[private rules] not set (' + role + ' build): no rules file written')
        return None
    try:
        doc = parse(raw)
    except Exception as e:
        raise SystemExit('[private rules] PRIVATE_RULES_JSON is invalid: ' + type(e).__name__)
    # Build variables renamed to vendor codes still work under their pre-code names (legacyNames).
    for new, old in doc['legacyNames'].items():
        if new.isupper() and not environ.get(new) and environ.get(old):
            environ[new] = environ[old]
    text = json.dumps(doc, separators=(',', ':'), ensure_ascii=False)
    for path in OUTPUTS:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            f.write(text)
    print(f"[private rules] version set, {len(doc)} keys, written for the dashboard and the verifier")
    return doc


def manual(doc, key):
    """Ordered (sku, cost) pairs, or [] when no rules were loaded (restricted/local builds)."""
    if not doc:
        return []
    return [(str(sku), float(cost)) for sku, cost in doc[key]]
