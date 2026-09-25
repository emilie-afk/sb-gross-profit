"""Run the real build.py against local source files, with no network.

    python3 run_build.py <workdir> <sources.json>

<workdir> already holds copies of build.py, vendor_sheets.py and catalog_hook.py
(parity.mjs makes it, outside the repository). <sources.json> maps build.py
environment names to local file paths, plus optional "productExport":
{"name": ..., "path": ...} for the Drive folder's newest export.

Every build.py fetch is answered from those files: each configured source gets
a placeholder URL (never a real one), and urllib.request.urlopen is replaced so
build.py's own parsing, Drive listing and fallbacks run unchanged. Any other URL
raises. The catalog push is not configured, so nothing leaves the machine.
"""
import io, json, os, runpy, sys, urllib.request, urllib.parse

workdir, sources_path = sys.argv[1], sys.argv[2]
sources = json.load(open(sources_path, encoding='utf-8'))

URL_KEYS = ['MCG_SHEET_URL', 'MCG_POTS_SHEET_URL', 'SB_SKU_ALIAS_URL', 'SB_SKU_ALIAS_URL_2', 'HP_SKU_ALIAS_URL',
            'AS_SHEET_URL', 'L2G_SHEET_URL', 'LIVELY_GOOD_SHEET_URL', 'CALATHEA_COLLECTIVE_SHEET_URL',
            'SURFSIDE_ARRANGEMENT_SHEET_URL', 'LINDAMAKES_SHEET_URL', 'HP_SHEET_URL', 'MCG_EXTRA_SHEET_URL']
JSON_KEYS = ['PRODUCT_COSTS_JSON1', 'PRODUCT_COSTS_JSON2', 'SKU_WEIGHTS_JSON']

for k in URL_KEYS + JSON_KEYS + ['HP_COSTS_FOLDER_ID', 'GDRIVE_API_KEY', 'CATALOG_PUSH_URL', 'SB_INGEST_SECRET',
                                 'VENDOR_IMPORT_STRICT', 'INCOMING_HOOK_BODY']:
    os.environ.pop(k, None)

routes = {}
for k in URL_KEYS:
    if k in sources:
        url = f'https://parity.invalid/{k}'
        os.environ[k] = url
        routes[url] = sources[k]
for k in JSON_KEYS:
    if k in sources:
        os.environ[k] = open(sources[k], encoding='utf-8').read()

pe = sources.get('productExport')
if pe:
    os.environ['HP_COSTS_FOLDER_ID'] = 'parityfolder'
    os.environ['GDRIVE_API_KEY'] = 'paritykey'


class _Resp(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *a): self.close()


def fake_urlopen(url, timeout=None, **kw):
    if not isinstance(url, str):
        raise ValueError('unexpected request object')
    if url in routes:
        return _Resp(open(routes[url], 'rb').read())
    u = urllib.parse.urlparse(url)
    if pe and u.netloc == 'www.googleapis.com' and u.path == '/drive/v3/files':
        listing = {'files': [{'id': 'parityfile', 'name': pe['name'], 'mimeType': 'text/csv'}]}
        return _Resp(json.dumps(listing).encode())
    if pe and u.netloc == 'www.googleapis.com' and u.path == '/drive/v3/files/parityfile':
        return _Resp(open(pe['path'], 'rb').read())
    raise OSError('parity harness: unexpected URL')


urllib.request.urlopen = fake_urlopen
sys.path.insert(0, workdir)
os.chdir(workdir)
_stdout = sys.stdout
sys.stdout = open(os.devnull, 'w')          # build.py prints sheet rows; keep them out of any log
try:
    runpy.run_path(os.path.join(workdir, 'build.py'), run_name='__main__')
finally:
    sys.stdout.close()
    sys.stdout = _stdout

# What push_catalog() would send as mcgExtraCsv (decode as build.py does).
if 'MCG_EXTRA_SHEET_URL' in sources:
    raw = open(sources['MCG_EXTRA_SHEET_URL'], 'rb').read().decode('utf-8', errors='replace')
    open(os.path.join(workdir, 'data', 'mcg_extra.csv.txt'), 'w', encoding='utf-8').write(raw)
print('ok')
