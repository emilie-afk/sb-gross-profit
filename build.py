"""
build.py — Netlify build script
================================
Runs on every Netlify deploy. Fetches cost data from external sources
and writes JSON files to data/ so the dashboard always has fresh costs.

Auto-fetched on every deploy:
  MCG            → Google Sheets (URL in MCG_SHEET_URL env var)
  Air Plant Shop → Google Sheets (URL in AS_SHEET_URL env var)
  Live to Give   → Google Sheets (URL in L2G_SHEET_URL env var)
  HP Dropship    → Google Sheet synced daily by Make.com "HP Dropship Cost Sync" scenario
                   URL in HP_SHEET_URL env var
                   Columns: SKU | Cost | WeightLb
                   Fallback: PRODUCT_COSTS_JSON1/2 + SKU_WEIGHTS_JSON env vars

Required Netlify env vars:
  SITE_PASSWORD      — dashboard login password
  MCG_SHEET_URL      — MCG Total sheet export URL (plant costs with extra cost)
  MCG_POTS_SHEET_URL — MCG Pot costs sheet export URL (pot SKU → pot cost)
  AS_SHEET_URL       — Air Plant Shop sheet export URL
  L2G_SHEET_URL      — Live to Give sheet export URL
  HP_SHEET_URL       — HP Dropship sheet export URL
HP fallback env vars (only if HP_SHEET_URL not set):
  PRODUCT_COSTS_JSON1, PRODUCT_COSTS_JSON2, SKU_WEIGHTS_JSON
"""

import os, json, csv, io, urllib.request

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
os.makedirs(DATA_DIR, exist_ok=True)


# ── Helpers ───────────────────────────────────────────────────────────────────

def fetch_csv(url, label, timeout=15):
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            text = r.read().decode('utf-8-sig')
        rows = list(csv.DictReader(io.StringIO(text)))
        print(f"  ✓ {label}: {len(rows)} rows")
        return rows
    except Exception as e:
        print(f"  ✗ {label}: {e}")
        return None

def clean_money(s):
    try:
        return float(str(s).replace('$', '').replace(',', '').strip())
    except:
        return None

def write_json(filename, data):
    path = os.path.join(DATA_DIR, filename)
    with open(path, 'w') as f:
        json.dump(data, f, separators=(',', ':'))
    kb = os.path.getsize(path) / 1024
    print(f"  → {filename}: {len(data)} entries ({kb:.1f} KB)")


# ── 1. MCG ────────────────────────────────────────────────────────────────────
print("\n[MCG]")
mcg_costs = {}
mcg_url = os.environ.get('MCG_SHEET_URL')
if mcg_url:
    rows = fetch_csv(mcg_url, 'MCG Total sheet')
    if rows:
        for row in rows:
            sku  = row.get('SKU', '').strip().upper()
            cost = clean_money(row.get('Cost Per Item', '') or row.get('Cost_Per_Item', ''))
            if sku and cost and cost > 0:
                mcg_costs[sku] = cost
        print(f"  → {len(mcg_costs)} MCG SKUs")
else:
    print("  ✗ MCG_SHEET_URL not set — skipping")

# MCG pot costs (EEZZ* SKUs used in plant+pot bundles like S2KY1153+EEZZ7620.BR-1)
# Merging into mcg_costs so getCost() finds them at priority 1 when splitting '+' bundles
pots_url = os.environ.get('MCG_POTS_SHEET_URL')
if pots_url:
    pot_rows = fetch_csv(pots_url, 'MCG Pot Costs sheet')
    if pot_rows:
        pot_count = 0
        for row in pot_rows:
            sku  = row.get('Pot SKU', '').strip().upper()
            cost = clean_money(row.get('Pot Cost', ''))
            if sku and cost and cost > 0:
                mcg_costs[sku] = cost
                pot_count += 1
        print(f"  → {pot_count} pot SKUs merged into MCG costs")
else:
    print("  ✗ MCG_POTS_SHEET_URL not set — pot bundle costs may be missing")


# ── 2. Air Plant Shop ─────────────────────────────────────────────────────────
print("\n[Air Plant Shop]")
as_costs = {}
as_url = os.environ.get('AS_SHEET_URL')
if as_url:
    rows = fetch_csv(as_url, 'Air Plant Shop sheet')
    if rows:
        for row in rows:
            # The sheet header is "SKU " (trailing space) — handle both
            sku  = (row.get('SKU ', '') or row.get('SKU', '')).strip().upper()
            cost = clean_money(row.get('Fullfilled Price', ''))
            if sku and cost and cost > 0:
                as_costs[sku] = cost
        print(f"  → {len(as_costs)} Air Plant Shop SKUs")
else:
    print("  ✗ AS_SHEET_URL not set — skipping")


# ── 3. Live to Give ───────────────────────────────────────────────────────────
print("\n[Live to Give]")
l2g_costs = {}
l2g_url = os.environ.get('L2G_SHEET_URL')
if l2g_url:
    rows = fetch_csv(l2g_url, 'Live to Give sheet')
    if rows:
        for row in rows:
            sku  = row.get('SKUs', '').strip().upper()
            cost = clean_money(row.get('Dropship Price (60% of retail price)', ''))
            if sku and cost and cost > 0:
                l2g_costs[sku] = cost
        print(f"  → {len(l2g_costs)} Live to Give SKUs")
else:
    print("  ✗ L2G_SHEET_URL not set — skipping")


# ── 4. HP Dropship (Google Sheet synced daily by Make.com) ────────────────────
print("\n[HP Dropship]")
hp_costs    = {}
sku_weights = {}

hp_url = os.environ.get('HP_SHEET_URL')
if hp_url:
    # Make.com scenario "HP Dropship Cost Sync" writes SKU/Cost/WeightLb here daily.
    # The sheet appends rows each run; later rows overwrite earlier ones in the dict,
    # so the most recent cost always wins.
    rows = fetch_csv(hp_url, 'HP Dropship sheet')
    if rows:
        for row in rows:
            sku    = row.get('SKU', '').strip().upper()
            cost   = clean_money(row.get('Cost', ''))
            weight = clean_money(row.get('WeightLb', ''))
            if sku and cost and cost > 0:
                hp_costs[sku] = cost
            if sku and weight and weight > 0:
                sku_weights[sku] = weight
        print(f"  → {len(hp_costs)} HP cost SKUs, {len(sku_weights)} weight SKUs")
else:
    print("  ✗ HP_SHEET_URL not set — trying env var fallback")

if not hp_costs:
    # Fallback: env vars (paste JSON from old update_costs.py output)
    p1 = json.loads(os.environ.get('PRODUCT_COSTS_JSON1', '{}'))
    p2 = json.loads(os.environ.get('PRODUCT_COSTS_JSON2', '{}'))
    hp_costs    = {**p1, **p2}
    sku_weights = json.loads(os.environ.get('SKU_WEIGHTS_JSON', '{}'))
    print(f"  → {len(hp_costs)} HP SKUs, {len(sku_weights)} weight SKUs (env var fallback)")


# ── 5. Shopify product exports (optional — only regenerates JSONs if CSVs present) ─
# sb_costs.json and hp_supplement.json are pre-generated from Shopify product exports.
# If the CSV files are present (e.g. local run), regenerate them. Otherwise keep
# the committed JSON files intact so Netlify always has them.
print("\n[Shopify Product Exports]")
import glob

export_files = sorted(glob.glob(os.path.join(DATA_DIR, 'products_export*.csv')))

if export_files:
    sb_costs = {}
    hp_suppl = {}
    print(f"  Found {len(export_files)} export file(s) — regenerating…")
    for export_path in export_files:
        current_vendor = ''
        try:
            with open(export_path, encoding='utf-8-sig') as f:
                for row in csv.DictReader(f):
                    v = (row.get('Vendor') or '').strip()
                    if v:
                        current_vendor = v
                    sku  = (row.get('Variant SKU') or '').strip().upper()
                    cost = clean_money(row.get('Cost per item', ''))
                    if sku and cost and cost > 0:
                        if current_vendor == 'Succulents Box':
                            sb_costs[sku] = cost
                        elif current_vendor in ('House Plant Dropship', 'House Plant Shop', 'House Plant Wholesale'):
                            hp_suppl[sku] = cost
            print(f"  ✓ {os.path.basename(export_path)}")
        except Exception as e:
            print(f"  ✗ {os.path.basename(export_path)}: {e}")
    write_json('sb_costs.json',      sb_costs)
    write_json('hp_supplement.json', hp_suppl)
else:
    # No CSVs — load from pre-committed JSONs (do not overwrite)
    sb_path  = os.path.join(DATA_DIR, 'sb_costs.json')
    hp_path  = os.path.join(DATA_DIR, 'hp_supplement.json')
    sb_costs = json.load(open(sb_path)) if os.path.exists(sb_path) else {}
    hp_suppl = json.load(open(hp_path)) if os.path.exists(hp_path) else {}
    print(f"  No CSVs found — using committed sb_costs.json ({len(sb_costs)} SKUs) "
          f"and hp_supplement.json ({len(hp_suppl)} SKUs)")


# ── 6. Merge and write ────────────────────────────────────────────────────────
# AS and L2G override HP if there's any SKU overlap; MCG is always separate
product_costs = {**hp_costs, **as_costs, **l2g_costs}

print("\nWriting data files...")
write_json('mcg_total.json',     mcg_costs)
write_json('product_costs.json', product_costs)
write_json('sku_weights.json',   sku_weights)
# sb_costs.json and hp_supplement.json written above (or kept from repo)

total = len(mcg_costs) + len(product_costs) + len(sb_costs) + len(hp_suppl)
print(f"\nBuild complete — {total} total SKUs across all sources.")
