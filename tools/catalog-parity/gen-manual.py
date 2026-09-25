"""Regenerate shared/catalogManual.js from the manual cost constants in build.py.

    python3 tools/catalog-parity/gen-manual.py            # write
    python3 tools/catalog-parity/gen-manual.py --check    # exit 1 if stale

The constants are read with ast.literal_eval (build.py is never executed), so
the order and last-wins behaviour of the Python dict literals are preserved.
"""
import ast, json, os, sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
NAMES = ('MANUAL_MCG_COSTS', 'MANUAL_LR_COSTS')


def render():
    tree = ast.parse(open(os.path.join(ROOT, 'build.py'), encoding='utf-8').read())
    found = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and getattr(node.targets[0], 'id', None) in NAMES:
            found[node.targets[0].id] = ast.literal_eval(node.value)
    missing = [n for n in NAMES if n not in found]
    if missing:
        raise SystemExit(f'build.py no longer defines {missing}')
    out = ('/**\n'
           ' * catalogManual.js — the manual cost constants in build.py, as ordered entries.\n'
           ' * GENERATED from build.py by tools/catalog-parity/gen-manual.py; do not edit by hand.\n'
           ' * tests/catalog-build.test.mjs fails if these drift from build.py.\n'
           ' */\n')
    for n in NAMES:
        entries = [[k, float(v)] for k, v in found[n].items()]
        out += f'export const {n} = Object.freeze({json.dumps(entries)});\n'
    return out


if __name__ == '__main__':
    target = os.path.join(ROOT, 'shared', 'catalogManual.js')
    text = render()
    if '--check' in sys.argv:
        current = open(target, encoding='utf-8').read() if os.path.exists(target) else ''
        sys.exit(0 if current == text else 1)
    open(target, 'w', encoding='utf-8').write(text)
