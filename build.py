"""
build.py — Netlify build script
================================
Runs on every Netlify deploy. Fetches cost data from external sources
and writes JSON files to data/ so the dashboard always has fresh costs.

Auto-fetched on every deploy:
  MCG            → Google Sheets (MCG Total tab)
  Air Plant Shop → Google Sheets
  Live to Give   → Google Sheets
  HP Dropship    → Google Sheet synced daily by Make.com "HP Dropship Cost Sync" scenario
                   Sheet ID: 14uVabyL8w2QgUPYLKN7XUuF5i4qxWp3IsUJCViK3zv8
                   Columns: SKU | Cost | WeightLb
                   Fallback: PRODUCT_COSTS_JSON1/2 + SKU_WEIGHTS_JSON env vars

Required Netlify env var : SITE_PASSWORD
HP fallback env vars     : PRODUCT_COSTS_JSON1, PRODUCT_COSTS_JSON2, SKU_WEIGHTS_JSON
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
rows = fetch_csv(
    'https://docs.google.com/spreadsheets/d/1PfIpGJyUCL0q7GwRetjT6YjRQQy_VDkUmZZ6o73Pxr0/export?format=csv&gid=1577209201',
    'MCG Total sheet'
)
if rows:
    for row in rows:
        sku  = row.get('SKU', '').strip().upper()
        cost = clean_money(row.get('Cost_Per_Item', ''))
        if sku and cost and cost > 0:
            mcg_costs[sku] = cost
    print(f"  → {len(mcg_costs)} MCG SKUs")


# ── 2. Air Plant Shop ─────────────────────────────────────────────────────────
print("\n[Air Plant Shop]")
as_costs = {}
rows = fetch_csv(
    'https://docs.google.com/spreadsheets/d/1jpwqcSxBVrv2gZQBelMy6E7SxXkQtp1ekWSuaiRtECY/export?format=csv&gid=994235120',
    'Air Plant Shop sheet'
)
if rows:
    for row in rows:
        # The sheet header is "SKU " (trailing space) — handle both
        sku  = (row.get('SKU ', '') or row.get('SKU', '')).strip().upper()
        cost = clean_money(row.get('Fullfilled Price', ''))
        if sku and cost and cost > 0:
            as_costs[sku] = cost
    print(f"  → {len(as_costs)} Air Plant Shop SKUs")


# ── 3. Live to Give ───────────────────────────────────────────────────────────
print("\n[Live to Give]")
l2g_costs = {}
rows = fetch_csv(
    'https://docs.google.com/spreadsheets/d/1jpwqcSxBVrv2gZQBelMy6E7SxXkQtp1ekWSuaiRtECY/export?format=csv&gid=1872945984',
    'Live to Give sheet'
)
if rows:
    for row in rows:
        sku  = row.get('SKUs', '').strip().upper()
        cost = clean_money(row.get('Dropship Price (60% of retail price)', ''))
        if sku and cost and cost > 0:
            l2g_costs[sku] = cost
    print(f"  → {len(l2g_costs)} Live to Give SKUs")


# ── 4. HP Dropship (Google Sheet synced daily by Make.com) ────────────────────
print("\n[HP Dropship]")
hp_costs    = {}
sku_weights = {}

# Make.com scenario "HP Dropship Cost Sync" writes SKU/Cost/WeightLb here daily.
# The sheet appends rows each run; later rows overwrite earlier ones in the dict,
# so the most recent cost always wins.
rows = fetch_csv(
    'https://docs.google.com/spreadsheets/d/14uVabyL8w2QgUPYLKN7XUuF5i4qxWp3IsUJCViK3zv8/export?format=csv&gid=0',
    'HP Dropship sheet'
)
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

if not hp_costs:
    # Fallback: env vars (paste JSON from old update_costs.py output)
    p1 = json.loads(os.environ.get('PRODUCT_COSTS_JSON1', '{}'))
    p2 = json.loads(os.environ.get('PRODUCT_COSTS_JSON2', '{}'))
    hp_costs    = {**p1, **p2}
    sku_weights = json.loads(os.environ.get('SKU_WEIGHTS_JSON', '{}'))
    print(f"  → {len(hp_costs)} HP SKUs, {len(sku_weights)} weight SKUs (env var fallback)")


# ── 5. Merge and write ────────────────────────────────────────────────────────
# AS and L2G override HP if there's any SKU overlap; MCG is always separate
product_costs = {**hp_costs, **as_costs, **l2g_costs}

print("\nWriting data files...")
write_json('mcg_total.json',     mcg_costs)
write_json('product_costs.json', product_costs)
write_json('sku_weights.json',   sku_weights)

print(f"\nBuild complete — {len(mcg_costs) + len(product_costs)} total SKUs.")
