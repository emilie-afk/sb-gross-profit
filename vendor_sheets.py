"""
vendor_sheets.py — vendor-scoped product cost import
====================================================
Imports product costs for the gift/arrangement vendors from the
"Products Master" Google Sheet (one tab per vendor) and returns a
VENDOR-AWARE catalog:

    {
      "Live to Give": {
        "PRAY DLX": {"unitCost": 29.99, "sku": "Pray DLX",
                     "productName": "Prayer Gift Box",
                     "source": "Live to Give sheet", "matchType": "exact_sku"}
      },
      ...
    }

The values imported here are PRODUCT costs (COGS). No shipping component is
imported — the Surfside tab carries a free-text shipping note column, and the
Calathea and LindaMakes tabs carry weight columns; none is part of product COGS.

Every tab is validated and the counts are printed so a Netlify build log shows
exactly what landed. A configured tab that yields zero valid costs is a loud
failure (and a hard build failure when VENDOR_IMPORT_STRICT is set).
"""

import os, csv, io, re, urllib.request

# Canonical vendor names — must match js/vendorCosts.js VENDOR_KEYS.
LIVE_TO_GIVE         = 'Live to Give'
LIVELY_GOOD          = 'Lively Good'
CALATHEA_COLLECTIVE  = 'Calathea Collective'
SURFSIDE_ARRANGEMENT = 'Surfside Arrangement'
LINDAMAKES           = 'LindaMakes'

VENDOR_ORDER = [LIVE_TO_GIVE, LIVELY_GOOD, CALATHEA_COLLECTIVE, SURFSIDE_ARRANGEMENT,
                LINDAMAKES]

# vendor → env var holding the CSV export URL of that tab
VENDOR_ENV = {
    LIVE_TO_GIVE:         'L2G_SHEET_URL',
    LIVELY_GOOD:          'LIVELY_GOOD_SHEET_URL',
    CALATHEA_COLLECTIVE:  'CALATHEA_COLLECTIVE_SHEET_URL',
    SURFSIDE_ARRANGEMENT: 'SURFSIDE_ARRANGEMENT_SHEET_URL',
    LINDAMAKES:           'LINDAMAKES_SHEET_URL',
}


# ── Normalization ─────────────────────────────────────────────────────────────

def normalize_sku(s):
    """Uppercase, collapse whitespace, drop surrounding junk.

    Kept deliberately conservative: separators inside the SKU (-, _, ., +) are
    preserved because they are meaningful in the existing SKU space. The
    original spelling is retained separately for display/auditing.
    """
    return re.sub(r'\s+', ' ', (s or '').strip()).upper()


def loose_sku(s):
    """Aggressive normalization used only as a secondary lookup key."""
    return re.sub(r'[^A-Z0-9]', '', normalize_sku(s))


def normalize_name(s):
    """Lowercase alphanumeric name key for name-based fallback matching."""
    s = (s or '').split('\n')[-1]
    return re.sub(r'\s+', ' ', re.sub(r'[^a-z0-9\s]', ' ', s.lower())).strip()


def display_name(s):
    """Sheets store 'Internal name\n\nShopify name' — prefer the Shopify name."""
    parts = [p.strip() for p in (s or '').split('\n') if p.strip()]
    return parts[-1] if parts else ''


def clean_money(s):
    if s is None:
        return None
    txt = str(s).replace('$', '').replace(',', '').strip()
    if not txt:
        return None
    try:
        return float(txt)
    except ValueError:
        return None


# ── Sheet fetching ────────────────────────────────────────────────────────────

def fetch_rows(url, timeout=20):
    with urllib.request.urlopen(url, timeout=timeout) as r:
        text = r.read().decode('utf-8-sig')
    return list(csv.reader(io.StringIO(text)))


def find_header_row(rows, required, max_scan=6):
    """Return the index of the first row containing all `required` labels."""
    want = [r.lower() for r in required]
    for i, row in enumerate(rows[:max_scan]):
        cells = [c.strip().lower() for c in row]
        if all(any(w == c or w in c for c in cells) for w in want):
            return i
    return None


def col_index(header, candidates):
    """First column index whose label matches any candidate (case/space loose).

    First occurrence wins — the Lively Good tab repeats 'SKU' / 'Cost per item'
    for a second (Succulents Box) block further right, and we want the left
    (vendor) block.
    """
    norm = [re.sub(r'\s+', ' ', (c or '').strip().lower()) for c in header]
    for cand in candidates:
        c = re.sub(r'\s+', ' ', cand.strip().lower())
        for i, h in enumerate(norm):
            if h == c:
                return i
    for cand in candidates:            # fall back to prefix match
        c = re.sub(r'\s+', ' ', cand.strip().lower())
        for i, h in enumerate(norm):
            if h.startswith(c):
                return i
    return None


# ── Per-vendor tab specs ──────────────────────────────────────────────────────
# Verified against the live tabs on 2026-09-22 (LindaMakes 2026-09-23);
# see DEPLOYMENT.md for gids.
VENDOR_SPECS = {
    LIVE_TO_GIVE: dict(
        header_required=['sku'],
        sku=['SKUs', 'SKU'],
        cost=['Dropship Price (60% of retail price)', 'Dropship Price', 'Cost'],
        name=['Shopify Name', 'Product'],
        carry_name=True,        # product name cell is merged across variant rows
        active=None,
    ),
    LIVELY_GOOD: dict(
        header_required=['sku', 'cost per item'],
        sku=['SKU'],
        cost=['Cost per item'],
        name=['Title'],
        carry_name=False,
        # Only rows flagged for the Shopify listing are sold by Succulents Box;
        # unchecked rows are fulfilled through other vendors.
        active=['Listing Shopify'],
    ),
    CALATHEA_COLLECTIVE: dict(
        header_required=['sku', 'cost'],
        sku=['SKU'],
        cost=['Cost (what Calathea Collective receives)', 'Cost'],
        name=['Product'],
        carry_name=True,        # merged product cell across option rows
        active=None,
    ),
    SURFSIDE_ARRANGEMENT: dict(
        header_required=['sb sku'],
        sku=['SB SKU', 'SKU'],
        cost=['Cost (what Surfside Succulents receives)', 'Cost'],
        name=['Product'],
        carry_name=True,
        active=None,
    ),
    LINDAMAKES: dict(
        header_required=['sku', 'cost'],
        sku=['SKU'],
        # The sheet header spells the vendor 'LindaMakess'; match on the prefix
        # so a later correction does not break the import.
        cost=['Cost (what LindaMakes receives)', 'Cost'],
        name=['Product'],
        carry_name=True,      # product cell is merged across colourway rows
        active=None,
    ),
}


def parse_vendor_tab(vendor, rows):
    """Parse one vendor tab → (catalog_dict, stats_dict, errors_list)."""
    spec = VENDOR_SPECS[vendor]
    stats = dict(vendor=vendor, rows_fetched=max(0, len(rows) - 1), rows_accepted=0,
                 unique_skus=0, duplicate_skus=0, blank_skus=0, invalid_costs=0,
                 zero_or_negative=0, inactive_skipped=0, conflicting_duplicates=0,
                 imported=0)
    errors = []

    hdr_idx = find_header_row(rows, spec['header_required'])
    if hdr_idx is None:
        errors.append(f"{vendor}: could not locate a header row containing "
                      f"{spec['header_required']}")
        return {}, stats, errors

    header = rows[hdr_idx]
    i_sku  = col_index(header, spec['sku'])
    i_cost = col_index(header, spec['cost'])
    i_name = col_index(header, spec['name']) if spec['name'] else None
    # The active/listed flag may be labelled in a group-header row ABOVE the
    # column header row (Lively Good puts "Listing Shopify" on row 0 while the
    # column headers are on row 1), so scan every row up to and including it.
    i_act = None
    if spec['active']:
        for cand_row in rows[:hdr_idx + 1]:
            i_act = col_index(cand_row, spec['active'])
            if i_act is not None:
                break

    if i_sku is None or i_cost is None:
        errors.append(f"{vendor}: SKU column {spec['sku']} or cost column "
                      f"{spec['cost']} not found in header {header}")
        return {}, stats, errors

    data_rows = rows[hdr_idx + 1:]
    stats['rows_fetched'] = len(data_rows)

    def cell(row, idx):
        return (row[idx].strip() if idx is not None and idx < len(row) else '')

    # sku_key → list of (cost, raw_sku, product_name)
    collected = {}
    current_name = ''

    for row in data_rows:
        if not any(c.strip() for c in row):
            continue
        name_cell = cell(row, i_name)
        if name_cell:
            current_name = name_cell
        raw_sku = cell(row, i_sku)
        if not raw_sku:
            stats['blank_skus'] += 1
            continue
        if i_act is not None:
            flag = cell(row, i_act).strip().upper()
            if flag not in ('TRUE', 'YES', 'X', '1', 'CHECKED'):
                stats['inactive_skipped'] += 1
                continue
        cost = clean_money(cell(row, i_cost))
        if cost is None:
            stats['invalid_costs'] += 1
            continue
        if cost <= 0:
            stats['zero_or_negative'] += 1
            continue
        pname = name_cell if not spec['carry_name'] else (name_cell or current_name)
        collected.setdefault(normalize_sku(raw_sku), []).append(
            (round(cost, 4), raw_sku, display_name(pname)))
        stats['rows_accepted'] += 1

    catalog = {}
    for key, entries in collected.items():
        costs = {e[0] for e in entries}
        if len(entries) > 1:
            stats['duplicate_skus'] += 1
        if len(costs) > 1:
            # Deterministic rule: these tabs are edited in place and give no
            # signal that later rows are newer, so a conflict is an error and
            # the SKU is withheld rather than guessed at.
            stats['conflicting_duplicates'] += 1
            errors.append(f"{vendor}: SKU {key} has conflicting costs "
                          f"{sorted(costs)} — not imported")
            continue
        cost, raw_sku, pname = entries[0]
        catalog[key] = {
            'unitCost':    cost,
            'sku':         raw_sku,
            'productName': pname,
            'source':      f'{vendor} sheet',
            'matchType':   'exact_sku',
        }

    stats['unique_skus'] = len(collected)
    stats['imported'] = len(catalog)
    return catalog, stats, errors


def import_vendor_costs(strict=False):
    """Fetch + parse every configured vendor tab.

    Returns (catalog, all_stats, warnings). Raises SystemExit when `strict`
    and a configured tab produced no costs.
    """
    catalog = {v: {} for v in VENDOR_ORDER}
    all_stats, warnings = [], []

    for vendor in VENDOR_ORDER:
        env_key = VENDOR_ENV[vendor]
        url = os.environ.get(env_key, '').strip()
        print(f"\n[{vendor}]")
        if not url:
            msg = f"{env_key} not set — no {vendor} costs imported"
            print(f"  ✗ {msg} — vendor catalog will be EMPTY")
            warnings.append(msg)
            all_stats.append(dict(vendor=vendor, configured=False, imported=0))
            if strict:
                raise SystemExit(f"VENDOR_IMPORT_STRICT: {msg}")
            continue
        try:
            rows = fetch_rows(url)
        except Exception as e:                                   # noqa: BLE001
            print(f"  ✗ fetch failed: {e}")
            warnings.append(f"{vendor}: sheet fetch failed ({e})")
            all_stats.append(dict(vendor=vendor, configured=True, imported=0,
                                  error=str(e)))
            continue

        vcat, stats, errors = parse_vendor_tab(vendor, rows)
        stats['configured'] = True
        catalog[vendor] = vcat
        all_stats.append(stats)

        print(f"  rows fetched      : {stats['rows_fetched']}")
        print(f"  rows accepted     : {stats['rows_accepted']}")
        print(f"  unique SKUs       : {stats['unique_skus']}")
        print(f"  duplicate SKUs    : {stats['duplicate_skus']}")
        print(f"  blank SKUs        : {stats['blank_skus']}")
        print(f"  invalid costs     : {stats['invalid_costs']}")
        print(f"  zero/negative     : {stats['zero_or_negative']}")
        if stats['inactive_skipped']:
            print(f"  not listed on Shopify (skipped): {stats['inactive_skipped']}")
        if stats['conflicting_duplicates']:
            print(f"  ⚠ conflicting duplicates: {stats['conflicting_duplicates']}")
        print(f"  → imported SKUs   : {stats['imported']}")

        for err in errors:
            print(f"  ⚠ {err}")
            warnings.append(err)

        if stats['imported'] == 0:
            msg = (f"{vendor}: {env_key} is configured but produced ZERO valid "
                   f"costs — refusing to treat this as a healthy import")
            print("  " + "!" * 68)
            print(f"  !! BUILD WARNING: {msg}")
            print("  " + "!" * 68)
            warnings.append(msg)
            if strict:
                raise SystemExit(f"VENDOR_IMPORT_STRICT: {msg}")

    return catalog, all_stats, warnings
