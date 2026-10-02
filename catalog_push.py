"""
catalog_push.py — split the cost catalog into bounded chunks for the Worker
=============================================================================
The Worker runs on Workers Free (10 ms CPU per request). One ~360 KB catalog push
took ~22 ms there, so build.py sends the catalog as chunks of key-sorted entries
(POST /v1/ingest/catalog/uploads → PUT …/chunks/:table/:part → POST …/seal).

Layout (what the Worker checks the chunks against):
  [table, 1, n]                       n chunks of the table's top-level entries
  [table, 2, [[group, n], ...]]       vendor_costs: groups (vendors), each in n chunks
Keys are sorted in JavaScript's order (UTF-16 code units) and every chunk holds a
contiguous key range, so the Worker can store each chunk as the exact fragment of the
table's canonical JSON. No network here: pure functions, tested from the JS suite.
"""
import json

DEPTH2 = {'vendor_costs'}
CHUNK_BYTES = 48_000          # serialized entries per chunk (the Worker accepts ≤ 96 KB)
CHUNK_ENTRIES = 1500          # (the Worker accepts ≤ 2,000)


def js_key(s):
    """JavaScript's default string order: UTF-16 code units."""
    return s.encode('utf-16-be')


def _split(obj):
    """Contiguous key ranges of a dict, each ≤ CHUNK_BYTES serialized and ≤ CHUNK_ENTRIES keys."""
    keys = sorted(obj.keys(), key=js_key)
    chunks, cur, size = [], {}, 2
    for k in keys:
        n = len(json.dumps({k: obj[k]}, ensure_ascii=False, separators=(',', ':'))) - 1
        if cur and (size + n > CHUNK_BYTES or len(cur) >= CHUNK_ENTRIES):
            chunks.append(cur)
            cur, size = {}, 2
        cur[k] = obj[k]
        size += n
    chunks.append(cur)             # an empty table is one empty chunk
    return chunks


def catalog_chunks(tables):
    """tables (name → dict) → (layout, chunks); chunks are (table, part, group | None, entries)."""
    layout, chunks = [], []
    for name, t in tables.items():
        if not isinstance(t, dict):
            raise ValueError(f'catalog table {name} is not an object')
        if name in DEPTH2:
            groups, part = [], 0
            for g in sorted(t.keys(), key=js_key):
                if not isinstance(t[g], dict):
                    raise ValueError(f'catalog table {name}.{g} is not an object')
                parts = _split(t[g])
                groups.append([g, len(parts)])
                for entries in parts:
                    chunks.append((name, part, g, entries))
                    part += 1
            if not groups:                 # the Worker needs at least one chunk: an empty depth-1 shape
                raise ValueError(f'catalog table {name} has no groups')
            layout.append([name, 2, groups])
        else:
            parts = _split(t)
            layout.append([name, 1, len(parts)])
            for part, entries in enumerate(parts):
                chunks.append((name, part, None, entries))
    return layout, chunks


if __name__ == '__main__':          # test hook: stdin {"tables": …} → stdout {"layout", "chunks"}
    import sys
    lay, ch = catalog_chunks(json.load(sys.stdin)['tables'])
    json.dump({'layout': lay, 'chunks': [{'table': t, 'part': p, 'group': g, 'entries': e} for t, p, g, e in ch]}, sys.stdout)
