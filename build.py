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
  SITE_PASSWORD         — dashboard login password
  MCG_SHEET_URL         — MCG Total sheet export URL (plant costs with extra cost)
  MCG_POTS_SHEET_URL    — MCG Pot costs sheet export URL (pot SKU → pot cost)
  AS_SHEET_URL          — Air Plant Shop sheet export URL
  L2G_SHEET_URL         — Live to Give sheet export URL
  HP_SHEET_URL          — HP Dropship sheet export URL (Make.com synced sheet)
  HP_COSTS_FOLDER_ID    — Google Drive folder ID containing Shopify product exports by date
  GDRIVE_API_KEY        — Google API key with Drive API access (folder must be shared publicly)
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
    try:
        with urllib.request.urlopen(pots_url, timeout=15) as r:
            raw_text = r.read().decode('utf-8-sig')
        raw_rows = list(csv.reader(io.StringIO(raw_text)))
        print(f"  Pot sheet raw rows: {len(raw_rows)}, first row: {raw_rows[0] if raw_rows else []}")

        # The sheet may have a title row ("MCG Product Calulator") before the real headers.
        # Scan for the row that contains 'Pot SKU' and use it as the header row.
        HEADER_SIGNALS = {'pot sku', 'sku', 'variant sku'}
        header_idx = None
        for i, row in enumerate(raw_rows):
            row_lower = [c.strip().lower() for c in row]
            if any(s in row_lower for s in HEADER_SIGNALS):
                header_idx = i
                break

        if header_idx is None:
            print("  ✗ Could not find header row in pot sheet — skipping")
            pot_rows = []
        else:
            print(f"  Header row found at index {header_idx}: {raw_rows[header_idx]}")
            header = raw_rows[header_idx]
            pot_rows = [dict(zip(header, row)) for row in raw_rows[header_idx + 1:]]

        pot_count = 0
        for row in pot_rows:
            sku = (row.get('Pot SKU') or row.get('SKU') or
                   row.get('Variant SKU') or row.get('pot sku') or '').strip().upper()
            cost = clean_money(
                row.get('Pot Cost') or row.get('Cost') or
                row.get('Cost per item') or row.get('Cost Per Item') or
                row.get('Cost_Per_Item') or row.get('pot cost') or ''
            )
            if sku and cost and cost > 0:
                mcg_costs[sku] = cost
                # Also store base SKU (EEZZ7620.BR-1 → EEZZ7620) for dot-strip fallback
                base = sku.split('.')[0]
                if base and base != sku:
                    mcg_costs.setdefault(base, cost)
                pot_count += 1
        print(f"  → {pot_count} pot SKUs merged into MCG costs")
        if pot_count == 0:
            print("  ✗ No pot costs parsed — verify 'Pot SKU' / 'Pot Cost' column names")
    except Exception as e:
        print(f"  ✗ MCG Pot Costs sheet error: {e}")
else:
    print("  ✗ MCG_POTS_SHEET_URL not set — pot bundle costs may be missing")


# ── 1c. SKU Alias map (Succulent Box SKU ↔ Amazon alias) ─────────────────────
# Sheet has two columns: canonical SB/MCG SKU  |  Amazon seller alias SKU
# We build a bidirectional map so either form can be looked up.
# Env var: SB_SKU_ALIAS_URL  (can be a single CSV export URL covering all tabs,
#          or set SB_SKU_ALIAS_URL_2 for a second tab)
print("\n[SKU Alias]")
sku_alias = {}   # alias_sku → canonical_sku

def parse_alias_rows(raw_rows, label):
    """Find header row, return list of dicts."""
    ALIAS_SIGNALS = {'sku', 'succulent sku', 'sb sku', 'mcg sku', 'amazon sku',
                     'amazon alias', 'seller sku', 'alias', 'internal sku', 'variant sku'}
    header_idx = None
    for i, row in enumerate(raw_rows):
        row_lower = [c.strip().lower() for c in row]
        if sum(1 for c in row_lower if c in ALIAS_SIGNALS) >= 2:
            header_idx = i
            break
    if header_idx is None:
        print(f"  ✗ {label}: could not find header row (need ≥2 SKU-like columns)")
        return []
    header = raw_rows[header_idx]
    print(f"  {label} header: {header}")
    return [dict(zip(header, row)) for row in raw_rows[header_idx + 1:]]

def extract_aliases(rows, label):
    count = 0
    for row in rows:
        # Normalise keys to lowercase for flexible matching
        rlow = {k.strip().lower(): v.strip().upper() for k, v in row.items() if v.strip()}
        # Find the canonical SB/MCG SKU column
        sb_sku = (rlow.get('succulent sku') or rlow.get('sb sku') or rlow.get('mcg sku') or
                  rlow.get('internal sku') or rlow.get('sku') or rlow.get('variant sku') or '')
        # Find the Amazon alias column
        amz_sku = (rlow.get('amazon sku') or rlow.get('amazon alias') or rlow.get('amazon') or
                   rlow.get('seller sku') or rlow.get('alias') or rlow.get('msku') or '')
        if sb_sku and amz_sku and sb_sku != amz_sku:
            sku_alias[amz_sku] = sb_sku   # amazon alias → canonical
            sku_alias[sb_sku]  = sb_sku   # canonical → itself (no-op but safe)
            count += 1
    print(f"  → {count} alias mappings from {label}")

for env_key in ('SB_SKU_ALIAS_URL', 'SB_SKU_ALIAS_URL_2', 'HP_SKU_ALIAS_URL'):
    alias_url = os.environ.get(env_key)
    if not alias_url:
        continue
    try:
        with urllib.request.urlopen(alias_url, timeout=15) as r:
            raw_text = r.read().decode('utf-8-sig')
        raw_rows = list(csv.reader(io.StringIO(raw_text)))
        alias_rows = parse_alias_rows(raw_rows, env_key)
        extract_aliases(alias_rows, env_key)
    except Exception as e:
        print(f"  ✗ {env_key}: {e}")

if not sku_alias:
    print("  SB_SKU_ALIAS_URL not set or no mappings found — skipping")


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


# ── 5. Shopify product exports ─────────────────────────────────────────────────
# Source priority:
#   A. Google Drive folder (HP_COSTS_FOLDER_ID + GDRIVE_API_KEY) — picks the latest file by date
#   B. Local data/products_export*.csv files (manual drop-in)
#   C. Pre-existing sb_costs.json / hp_supplement.json (committed or from a previous run)
print("\n[Shopify Product Exports]")
import glob, urllib.parse

HP_VENDORS_SET = {'House Plant Dropship', 'House Plant Shop', 'House Plant Wholesale'}

def normalize_title(s):
    """Lowercase, strip non-alphanumeric, collapse spaces — for name-based cost lookup."""
    import re
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9\s]', '', s.lower())).strip()

def parse_shopify_export_rows(rows, label):
    """Parse Shopify product export rows → (sb_costs, hp_suppl, hp_by_name) dicts.
    hp_by_name keys by normalized product title so no-SKU variants can be matched."""
    sb, hp, hp_by_name = {}, {}, {}
    current_vendor = ''
    current_title  = ''
    for row in rows:
        v = (row.get('Vendor') or '').strip()
        if v:
            current_vendor = v
        t = (row.get('Title') or '').strip()
        if t:
            current_title = t
        sku  = (row.get('Variant SKU') or '').strip().upper()
        cost = clean_money(row.get('Cost per item', ''))
        if cost and cost > 0:
            if sku:
                if current_vendor == 'Succulents Box':
                    sb[sku] = cost
                elif current_vendor in HP_VENDORS_SET:
                    hp[sku] = cost
            # Build name→cost for HP even when SKU is missing (Shopify variant-ID orders)
            if current_vendor in HP_VENDORS_SET and current_title:
                key = normalize_title(current_title)
                if key and key not in hp_by_name:  # first variant's cost wins
                    hp_by_name[key] = cost
    print(f"  ✓ {label}: {len(sb)} SB SKUs, {len(hp)} HP SKUs, {len(hp_by_name)} HP titles")
    return sb, hp, hp_by_name

sb_costs   = {}
hp_suppl   = {}
hp_by_name = {}
export_source = None

# ── A. Google Drive folder ──────────────────────────────────────────────────
folder_id  = os.environ.get('HP_COSTS_FOLDER_ID', '').strip()
gdrive_key = os.environ.get('GDRIVE_API_KEY', '').strip()

if folder_id and gdrive_key:
    print("  Checking Google Drive folder for latest export…")
    try:
        q = urllib.parse.quote(f"'{folder_id}' in parents and trashed=false")
        list_url = (
            f'https://www.googleapis.com/drive/v3/files'
            f'?q={q}'
            f'&orderBy=name+desc'
            f'&pageSize=10'
            f'&fields=files(id,name,mimeType)'
            f'&key={gdrive_key}'
        )
        with urllib.request.urlopen(list_url, timeout=15) as r:
            file_list = json.loads(r.read().decode())

        drive_files = file_list.get('files', [])
        # Prefer CSV files over Google Sheets (but accept both)
        csv_files   = [f for f in drive_files if 'spreadsheet' not in f.get('mimeType','')]
        sheet_files = [f for f in drive_files if 'spreadsheet'     in f.get('mimeType','')]
        ordered     = csv_files + sheet_files  # CSVs first; newest name first within each

        if ordered:
            best = ordered[0]
            print(f"  Latest file: {best['name']}")
            mime = best.get('mimeType', '')
            if 'spreadsheet' in mime:
                dl_url = f"https://docs.google.com/spreadsheets/d/{best['id']}/export?format=csv"
            else:
                dl_url = (f"https://www.googleapis.com/drive/v3/files/{best['id']}"
                          f"?alt=media&key={gdrive_key}")
            rows = fetch_csv(dl_url, best['name'])
            if rows:
                sb_costs, hp_suppl, hp_by_name = parse_shopify_export_rows(rows, best['name'])
                export_source = f"Drive ({best['name']})"
        else:
            print("  ✗ No files found in Drive folder")
    except Exception as e:
        print(f"  ✗ Drive API error: {e}")
else:
    print("  HP_COSTS_FOLDER_ID / GDRIVE_API_KEY not set — skipping Drive")

# ── B. Local CSV files ──────────────────────────────────────────────────────
if not export_source:
    local_files = sorted(glob.glob(os.path.join(DATA_DIR, 'products_export*.csv')), reverse=True)
    if local_files:
        print(f"  Found {len(local_files)} local export file(s) — using all")
        for export_path in local_files:
            try:
                with open(export_path, encoding='utf-8-sig') as f:
                    rows = list(csv.DictReader(f))
                sb_new, hp_new, name_new = parse_shopify_export_rows(rows, os.path.basename(export_path))
                sb_costs.update(sb_new)
                hp_suppl.update(hp_new)
                hp_by_name.update(name_new)
                export_source = 'local files'
            except Exception as e:
                print(f"  ✗ {os.path.basename(export_path)}: {e}")

# ── C. Fall back to existing committed JSONs ────────────────────────────────
if export_source:
    write_json('sb_costs.json',      sb_costs)
    write_json('hp_supplement.json', hp_suppl)
    write_json('hp_by_name.json',    hp_by_name)
else:
    sb_path   = os.path.join(DATA_DIR, 'sb_costs.json')
    hp_path   = os.path.join(DATA_DIR, 'hp_supplement.json')
    name_path = os.path.join(DATA_DIR, 'hp_by_name.json')
    sb_costs   = json.load(open(sb_path))   if os.path.exists(sb_path)   else {}
    hp_suppl   = json.load(open(hp_path))   if os.path.exists(hp_path)   else {}
    hp_by_name = json.load(open(name_path)) if os.path.exists(name_path) else {}
    print(f"  No export source found — using existing JSONs "
          f"({len(sb_costs)} SB, {len(hp_suppl)} HP SKUs, {len(hp_by_name)} HP titles)")


# ── 6. Merge and write ────────────────────────────────────────────────────────
# AS and L2G override HP if there's any SKU overlap; MCG is always separate
product_costs = {**hp_costs, **as_costs, **l2g_costs}

print("\nWriting data files...")
write_json('mcg_total.json',     mcg_costs)
write_json('product_costs.json', product_costs)
write_json('sku_weights.json',   sku_weights)
write_json('sku_alias.json',     sku_alias)
# sb_costs.json and hp_supplement.json written above (or kept from repo)

total = len(mcg_costs) + len(product_costs) + len(sb_costs) + len(hp_suppl)
print(f"\nBuild complete — {total} total SKUs across all sources.")
