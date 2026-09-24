"""
catalog_hook.py — read the catalog-refresh id from a Netlify build-hook payload.

Make S0 POSTs {"refreshId": "crf_…", "weekStart": "YYYY-MM-DD"} to the Netlify
build hook. Netlify exposes the raw request body to the build as the
INCOMING_HOOK_BODY environment variable. build.py echoes the id back with the
catalog push so the Worker resolves exactly that refresh.

Anything that is not a well-formed refresh id — no body, malformed JSON, a
JSON list, a wrong-shaped id, an id with extra characters — yields None, and
the push then carries no refreshId (so it can resolve no refresh at all).
"""
import json
import re

REFRESH_ID_RE = re.compile(r'crf_[0-9a-f]{20}')


def refresh_id_from_hook_body(raw):
    if not raw:
        return None
    try:
        body = json.loads(raw)
    except (ValueError, TypeError):
        return None
    if not isinstance(body, dict):
        return None
    v = body.get('refreshId')
    return v if isinstance(v, str) and REFRESH_ID_RE.fullmatch(v) else None
