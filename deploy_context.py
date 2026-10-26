"""
deploy_context.py — which Netlify builds may read the private cost sources and push a catalog
=============================================================================================
Netlify sets CONTEXT (production | deploy-preview | branch-deploy | dev) and BRANCH for every build.
Variable scopes in the Netlify UI are the main control; this guard is the second one, because a
branch-specific value (for the staging branch) also reaches Deploy Previews opened from that branch.

  production                                   → may read sources and push (target must not be a staging Worker)
  branch-deploy of STAGING_BRANCH              → may read sources and push (target must be a staging Worker)
  no CONTEXT (a local run, the parity tool)    → unchanged
  anything else (Deploy Previews, other branch
  deploys, netlify dev)                        → every private source and the push are removed from the
                                                 environment before build.py reads it; the build still succeeds

Nothing here prints a value: only variable names, the context and the branch name.
"""
import os
from urllib.parse import urlparse

STAGING_BRANCH = 'weekly-automation-phase1'

# Everything a build could use to read private cost data or write a catalog.
PRIVATE_KEYS = (
    'CATALOG_PUSH_URL', 'SB_INGEST_SECRET', 'HP_COSTS_FOLDER_ID', 'GDRIVE_API_KEY',
    'PRODUCT_COSTS_JSON1', 'PRODUCT_COSTS_JSON2', 'SKU_WEIGHTS_JSON',
)
def _is_private(key):
    return key in PRIVATE_KEYS or key.endswith('_SHEET_URL') or '_SKU_ALIAS_URL' in key


def build_role(environ=os.environ):
    """'production' | 'staging' | 'local' | 'restricted'."""
    ctx = (environ.get('CONTEXT') or '').strip()
    branch = (environ.get('BRANCH') or environ.get('HEAD') or '').strip()
    if not ctx:
        return 'local'
    if ctx == 'production':
        return 'production'
    if ctx == 'branch-deploy' and branch == STAGING_BRANCH:
        return 'staging'
    return 'restricted'


def apply(environ=os.environ):
    """Removes the private sources from a restricted build's environment. Returns (role, removed key names)."""
    role = build_role(environ)
    removed = []
    if role == 'restricted':
        for k in sorted(list(environ.keys())):
            if _is_private(k) and environ.get(k):
                removed.append(k)
                del environ[k]
    ctx = environ.get('CONTEXT') or 'none'
    branch = environ.get('BRANCH') or environ.get('HEAD') or 'none'
    if role == 'restricted':
        print(f"[deploy context] {ctx} on branch {branch}: private cost sources and the catalog push are disabled "
              f"({len(removed)} variable(s) ignored: {', '.join(removed) or 'none set'})")
    else:
        print(f"[deploy context] {ctx} on branch {branch}: role {role}")
    return role, removed


def push_target_problem(url, role):
    """Why this catalog push target does not fit the build's role (no URL in the message), or None."""
    host = (urlparse(url).hostname or '').lower()
    staging_host = 'staging' in host
    if role == 'restricted':
        return 'this deploy context may not push a catalog'
    if role == 'production' and staging_host:
        return 'a production build must not push to a staging Worker'
    if role == 'staging' and not staging_host:
        return f'the {STAGING_BRANCH} branch may push only to a staging Worker'
    return None
