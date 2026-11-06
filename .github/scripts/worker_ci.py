#!/usr/bin/env python3
"""Worker deploy and reporting-key rotation for GitHub Actions.

This repository is public, so its Actions logs are public too. Every message this script prints is a fixed text,
optionally with a count, an HTTP status, an exit code, or the name of a variable that is already public in
wrangler.toml. It never prints secrets, response bodies, wrangler output, ids, addresses or private settings.
HTTP redirects are never followed, so no credential is ever sent to a second destination.

  python3 worker_ci.py deploy   checks (bundle inputs, live migrations, live settings), then `wrangler deploy`
  python3 worker_ci.py rotate   resumable two-slot rotation of the reporting key (see rotate())

Secrets (environment "worker-production"): CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, D1_DATABASE_ID, WORKER_URL,
  WORKER_VAR_OVERRIDES (optional JSON object); for rotate also NETLIFY_AUTH_TOKEN, NETLIFY_ACCOUNT_ID,
  NETLIFY_DASHBOARD_SITE_ID, DASHBOARD_URL, PULL_CHECK_TOKEN.
Plain settings (workflow file): WORKER_DIR, WRANGLER_BIN, ESBUILD_BIN, TRIGGER_PATHS, REPORTING_PATH, REPORTING_AUTH,
  SOURCE_KEY, DASHBOARD_SECRET_VAR, DASHBOARD_URL_VAR, ALLOW_SETTING_CHANGES.
"""
import datetime
import glob
import hashlib
import json
import os
import secrets
import subprocess
import sys
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request

CF_API = "https://api.cloudflare.com/client/v4"
NETLIFY_API = "https://api.netlify.com/api/v1"
TIMEOUT = 30
SLEEP = time.sleep                                    # replaced in tests
NOW = time.monotonic
DEPLOY_WAIT_SECONDS = 20 * 60
IN_PROGRESS = {"new", "pending_review", "accepted", "enqueued", "building", "uploading", "uploaded", "preparing",
               "prepared", "processing", "processed", "retrying"}
FAILED = {"error", "rejected", "cancelled"}


class Fail(Exception):
    """A failure whose message is a fixed text that is safe in a public log."""


def env(name, required=True):
    value = os.environ.get(name, "").strip()
    if required and not value:
        raise Fail(f"{name} is not set for this environment")
    return value


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------- HTTP: no redirects, status codes only

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None                                   # a 3xx becomes an HTTPError: never re-sent anywhere


_OPENER = urllib.request.build_opener(_NoRedirect)


def http(method, url, headers=None, body=None, label="request", ok=(200,), want_headers=False):
    """One request, never redirected. Returns (status, parsed JSON or None). The body of an error is never read."""
    data = None
    headers = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode()
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with _OPENER.open(req, timeout=TIMEOUT) as res:
            status, raw, rh = res.status, res.read(5_000_000), {k.lower(): v for k, v in res.headers.items()}
    except urllib.error.HTTPError as e:
        status, raw, rh = e.code, b"", {}
        e.close()
    except (urllib.error.URLError, TimeoutError, OSError):
        raise Fail(f"{label}: could not connect")
    if 300 <= status < 400 and status not in ok:
        raise Fail(f"{label}: redirect refused (HTTP {status})")
    if status not in ok:
        raise Fail(f"{label}: HTTP {status}")
    try:
        data = json.loads(raw) if raw else None
    except ValueError:
        data = None
    return (status, data, rh) if want_headers else (status, data)


def cf(method, path, label, body=None):
    token, account = env("CLOUDFLARE_API_TOKEN"), env("CLOUDFLARE_ACCOUNT_ID")
    _, data = http(method, f"{CF_API}/accounts/{urllib.parse.quote(account)}{path}",
                   {"authorization": f"Bearer {token}"}, body, label=label)
    if not isinstance(data, dict) or not data.get("success"):
        raise Fail(f"{label}: Cloudflare reported an error")
    return data["result"]


def netlify(method, path, label, body=None, ok=(200,)):
    return http(method, NETLIFY_API + path, {"authorization": f"Bearer {env('NETLIFY_AUTH_TOKEN')}"}, body, label=label, ok=ok)


# ---------------------------------------------------------------- configuration

def build_config():
    """The repository's wrangler.toml (top level only, never [env.*]) plus the private D1 id and optional private
    variable values, written outside the checkout with mode 600. Returns (config, path, public variable names)."""
    worker_dir = os.path.abspath(env("WORKER_DIR"))
    with open(os.path.join(worker_dir, "wrangler.toml"), "rb") as f:
        cfg = tomllib.load(f)
    cfg.pop("env", None)
    public_vars = set(cfg.get("vars", {}))
    cfg["main"] = os.path.join(worker_dir, cfg["main"])
    d1 = cfg.get("d1_databases", [])
    if len(d1) != 1:
        raise Fail("expected exactly one D1 binding in wrangler.toml")
    d1[0]["database_id"] = env("D1_DATABASE_ID")
    d1[0]["migrations_dir"] = os.path.join(worker_dir, d1[0].get("migrations_dir", "migrations"))
    overrides = env("WORKER_VAR_OVERRIDES", required=False)
    if overrides:
        try:
            extra = json.loads(overrides)
        except ValueError:
            raise Fail("WORKER_VAR_OVERRIDES is not valid JSON")
        if not isinstance(extra, dict):
            raise Fail("WORKER_VAR_OVERRIDES must be a JSON object")
        cfg.setdefault("vars", {}).update(extra)
    path = os.path.join(env("RUNNER_TEMP"), "wrangler.ci.json")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        json.dump(cfg, f)
    return cfg, path, public_vars


# ---------------------------------------------------------------- deploy checks

def check_bundle_inputs(cfg):
    """Every file the Worker bundles must sit under the workflow's trigger paths; otherwise a change to it would
    never start a deploy. Uses esbuild's metafile (the bundler wrangler uses)."""
    meta = os.path.join(env("RUNNER_TEMP"), "bundle-meta.json")
    out = os.path.join(env("RUNNER_TEMP"), "bundle-check.js")
    cmd = [env("ESBUILD_BIN"), cfg["main"], "--bundle", "--format=esm", "--platform=neutral",
           "--main-fields=browser,module,main", "--conditions=workerd,worker,browser",
           "--external:cloudflare:*", "--external:node:*", f"--metafile={meta}", f"--outfile={out}", "--log-level=silent"]
    res = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if res.returncode != 0:
        raise Fail(f"bundle check failed (exit {res.returncode}); nothing was deployed")
    with open(meta) as f:
        inputs = list(json.load(f)["inputs"])
    prefixes = [p.strip().rstrip("*").rstrip("/") + "/" for p in env("TRIGGER_PATHS").split() if p.strip()]
    outside = [p for p in inputs if not any(os.path.normpath(p).startswith(x) for x in prefixes)]
    if outside:
        raise Fail(f"{len(outside)} Worker source file(s) are outside the workflow's trigger paths; add their folders "
                   "to TRIGGER_PATHS and on.push.paths in worker.yml. Nothing was deployed")
    return len(inputs)


def check_migrations(cfg):
    """Every migration file in the repository must already be applied on the live database. This reads the live
    D1 migration table (read-only), so a migration left unapplied by an earlier push still stops this deploy."""
    files = sorted(os.path.basename(p) for p in glob.glob(os.path.join(cfg["d1_databases"][0]["migrations_dir"], "*.sql")))
    db = urllib.parse.quote(cfg["d1_databases"][0]["database_id"])
    result = cf("POST", f"/d1/database/{db}/query", "read applied migrations",
                {"sql": "SELECT name FROM d1_migrations"})
    try:
        applied = {row["name"] for row in result[0]["results"]}
    except (KeyError, IndexError, TypeError):
        raise Fail("read applied migrations: unexpected answer")
    pending = [f for f in files if f not in applied]
    if pending:
        raise Fail(f"{len(pending)} database migration(s) in the repository are not applied on the live database. "
                   "Apply them, then run this workflow (deploy) again. Nothing was deployed")
    return len(files)


def setting_differences(cfg, public_vars):
    """Live settings the deploy would change. Wrangler replaces variables, bindings and cron schedules with what the
    configuration says, so a value set only in Cloudflare would silently be lost. Returns printable lines: names
    that are public in wrangler.toml, and a count for anything else."""
    name = urllib.parse.quote(cfg["name"])
    live = cf("GET", f"/workers/scripts/{name}/settings", "read live Worker settings")
    want_vars = cfg.get("vars", {})
    want_d1 = {b["binding"]: b["database_id"] for b in cfg.get("d1_databases", [])}
    named, unnamed, seen = [], 0, set()

    def differs(var):
        nonlocal unnamed
        if var in public_vars:
            named.append(f"variable {var}")
        else:
            unnamed += 1

    for b in live.get("bindings", []):
        t, n = b.get("type"), b.get("name")
        if t == "secret_text":
            continue                                   # secrets are kept by wrangler deploy
        seen.add(n)
        if t == "plain_text":
            if n not in want_vars or want_vars[n] != b.get("text"):
                differs(n)
        elif t == "json":
            if n not in want_vars or want_vars[n] != b.get("json"):
                differs(n)
        elif t == "d1":
            if want_d1.get(n) != (b.get("id") or b.get("database_id")):
                raise Fail("the D1_DATABASE_ID secret does not match the live database binding. Nothing was deployed")
        else:
            unnamed += 1                               # another binding kind a deploy would remove
    for n in want_vars:
        if n not in seen:
            differs(n)
    for n in want_d1:
        if n not in seen:
            unnamed += 1
    live_crons = sorted(s["cron"] for s in cf("GET", f"/workers/scripts/{name}/schedules",
                                                 "read live cron schedules").get("schedules", []))
    if live_crons != sorted(cfg.get("triggers", {}).get("crons", [])):
        named.append("cron schedules")
    if unnamed:
        named.append(f"{unnamed} other setting(s) not named in wrangler.toml")
    return named


# ---------------------------------------------------------------- wrangler

def wrangler(args, config_path, stdin=None, label="wrangler"):
    """Runs wrangler. Its output is never printed (it can contain ids, addresses and settings); a failure reports
    the step and exit code only."""
    keep = ("PATH", "HOME", "RUNNER_TEMP", "CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID", "HTTPS_PROXY", "HTTP_PROXY",
            "NO_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE")
    run_env = {k: os.environ[k] for k in keep if k in os.environ}
    run_env.update(WRANGLER_SEND_METRICS="false", NO_COLOR="1", CI="true")
    try:
        res = subprocess.run([env("WRANGLER_BIN"), *args, "--config", config_path], input=stdin,
                             capture_output=True, text=True, env=run_env, timeout=600)
    except subprocess.TimeoutExpired:
        raise Fail(f"{label} timed out")
    if res.returncode != 0:
        raise Fail(f"{label} failed (exit {res.returncode})")
    return res.stdout


# ---------------------------------------------------------------- tasks

def deploy():
    cfg, path, public_vars = build_config()
    n = check_bundle_inputs(cfg)
    log(f"Bundle check passed ({n} source files, all under the trigger paths)")
    m = check_migrations(cfg)
    log(f"Migration check passed ({m} migrations, all applied on the live database)")
    diffs = setting_differences(cfg, public_vars)
    if diffs:
        log("This deploy would change live Worker settings:")
        for d in diffs:
            log(f"  - {d}")
        if os.environ.get("ALLOW_SETTING_CHANGES") != "true":
            raise Fail("Stopped before deploying. Put the live values in wrangler.toml or WORKER_VAR_OVERRIDES, "
                       "or run the workflow by hand with 'allow setting changes' if the change is intended")
        log("Continuing: setting changes were allowed for this manual run")
    wrangler(["deploy"], path, label="wrangler deploy")
    log("Deployed")


def origin_of(raw, name):
    u = urllib.parse.urlsplit(raw)
    if u.scheme != "https" or not u.hostname or u.username or u.password:
        raise Fail(f"{name} must be an https address")
    return f"https://{u.netloc}"


def worker_check(origin, key):
    """(status, slots) of one reporting read; slots are the Worker's X-Reporting-Key-Slot ("1", "2")."""
    headers = {}
    if key is not None:
        auth = env("REPORTING_AUTH")
        if auth == "bearer":
            headers["authorization"] = f"Bearer {key}"
        elif auth.startswith("header:"):
            headers[auth.split(":", 1)[1]] = key
        else:
            raise Fail("REPORTING_AUTH must be 'bearer' or 'header:<Name>'")
    status, _, h = http("GET", origin + env("REPORTING_PATH"), headers, label="Worker reporting check",
                        ok=tuple(range(200, 300)) + tuple(range(400, 600)), want_headers=True)
    slots = sorted(s for s in (h.get("x-reporting-key-slot") or "").split(",") if s in ("1", "2"))
    return status, slots


def expect_worker_reads(origin, key, slot):
    status, slots = None, []
    for _ in range(12):                                # a secret can take a few seconds to reach every location
        status, slots = worker_check(origin, key)
        if status == 200 and slot in slots:
            return
        SLEEP(5)
    seen = "no slot reported" if not slots else "slot " + ",".join(slots) + " reported"
    raise Fail(f"the Worker did not accept the key in slot {slot} within one minute (last answer: HTTP {status}, {seen}). "
               f"{worker_url_hint()}")


def worker_url_hint():
    """Whether WORKER_URL points at this Worker's workers.dev address. Says yes/no only; never prints an address."""
    try:
        name = urllib.parse.quote(build_config()[0]["name"])
        sub = cf("GET", "/workers/subdomain", "read workers.dev subdomain").get("subdomain")
        host = urllib.parse.urlsplit(env("WORKER_URL")).hostname or ""
        if sub and host == f"{name}.{sub}.workers.dev":
            return "WORKER_URL points to this Worker's workers.dev address"
        if sub and host.endswith(".workers.dev"):
            return "WORKER_URL is a workers.dev address of a DIFFERENT Worker; set it to this Worker's address"
        return "WORKER_URL is not this Worker's workers.dev address; check it points to this Worker (custom domains are fine)"
    except Fail:
        return "could not compare WORKER_URL with this Worker's address"


def expect_no_key_refused(origin):
    s, _ = worker_check(origin, None)
    if s not in (401, 403):
        raise Fail(f"the Worker reporting route answered HTTP {s} without a key; expected 401")


def key_id(key):
    """Non-secret key identifier; the dashboard's /api/pull-check computes the same."""
    return hashlib.sha256(f"sb-reporting-key-id:{key}".encode()).hexdigest()[:16]


SLOT_SECRET = {"1": "REPORTING_SECRET", "2": "REPORTING_SECRET_NEXT"}
OTHER = {"1": "2", "2": "1"}


def worker_filled_slots(cfg):
    """Which slots hold a key, from the Worker's secret NAMES (Cloudflare never returns secret values)."""
    live = cf("GET", f"/workers/scripts/{urllib.parse.quote(cfg['name'])}/settings", "read live Worker settings")
    names = {b.get("name") for b in live.get("bindings", []) if b.get("type") == "secret_text"}
    return {slot for slot, name in SLOT_SECRET.items() if name in names}


# ---------------------------------------------------------------- dashboard (Netlify site and its pull check)

def _env_path(key):
    acct, site = urllib.parse.quote(env("NETLIFY_ACCOUNT_ID")), urllib.parse.quote(env("NETLIFY_DASHBOARD_SITE_ID"))
    return f"/accounts/{acct}/env", f"/accounts/{acct}/env/{key}", f"?site_id={site}"


def dashboard_set(key, value, secret, context, scopes=("functions",)):
    base, one, q = _env_path(key)
    status, _ = netlify("GET", one + q, f"read dashboard setting {key}", ok=(200, 404))
    if status == 404:
        netlify("POST", base + q, f"create dashboard setting {key}", [{"key": key, "scopes": list(scopes),
                "is_secret": secret, "values": [{"context": context, "value": value}]}], ok=(200, 201))
    else:
        netlify("PATCH", one + q, f"update dashboard setting {key}", {"context": context, "value": value}, ok=(200, 201))


def state_key():
    return "REPORTING_ROTATION_" + env("SOURCE_KEY").upper()


def read_state():
    """Durable private rotation state on the dashboard site (readable only with the Netlify token): which Worker slot
    and key id the dashboard's reporting-key SETTING holds. It may be ahead of the live deploy."""
    _, one, q = _env_path(state_key())
    status, data = netlify("GET", one + q, "read rotation state", ok=(200, 404))
    if status == 404:
        return None
    try:
        raw = next(v["value"] for v in data["values"] if v.get("context") in ("all", "production"))
        st = json.loads(raw)
        if st.get("slot") in ("1", "2") and isinstance(st.get("key_id"), str) and len(st["key_id"]) == 16:
            return st
    except (KeyError, TypeError, ValueError, StopIteration):
        pass
    raise Fail("the rotation state on the dashboard site is unreadable; nothing was changed")


def write_state(slot, kid):
    dashboard_set(state_key(), json.dumps({"slot": slot, "key_id": kid}), secret=False, context="all", scopes=("builds",))


def delete_state():
    _, one, q = _env_path(state_key())
    netlify("DELETE", one + q, "clear rotation state", ok=(200, 204, 404))


def _ts(s):
    return datetime.datetime.fromisoformat(str(s).replace("Z", "+00:00"))


def _production_builds_running():
    site = urllib.parse.quote(env("NETLIFY_DASHBOARD_SITE_ID"))
    _, recent = netlify("GET", f"/sites/{site}/deploys?per_page=20", "list dashboard deploys")
    return any(x.get("context") == "production" and x.get("state") in IN_PROGRESS for x in recent or [])


def wait_quiet():
    """Waits until no production build of the dashboard is running, so the live deploy is the only one in use."""
    deadline = NOW() + DEPLOY_WAIT_SECONDS
    while _production_builds_running():
        if NOW() >= deadline:
            raise Fail("a dashboard build has been running for over 20 minutes; nothing was changed")
        SLEEP(15)


def dashboard_redeploy_and_wait():
    """Starts a production build and waits until the LIVE deploy was created no earlier than that build, with no
    production build still running, so the live deploy carries the settings saved before this call. Builds again if
    an older build finished last and went live."""
    site = urllib.parse.quote(env("NETLIFY_DASHBOARD_SITE_ID"))

    def start():
        _, build = netlify("POST", f"/sites/{site}/builds", "start dashboard build", ok=(200, 201))
        did = (build or {}).get("deploy_id")
        if not did:
            raise Fail("start dashboard build: unexpected answer")
        _, d = netlify("GET", f"/deploys/{urllib.parse.quote(did)}", "read dashboard deploy")
        return did, _ts(d["created_at"])
    deploy_id, since = start()
    restarts = 0
    deadline = NOW() + DEPLOY_WAIT_SECONDS
    while NOW() < deadline:
        _, d = netlify("GET", f"/deploys/{urllib.parse.quote(deploy_id)}", "read dashboard deploy")
        if d.get("state") in FAILED:
            raise Fail("the dashboard deploy failed")
        running = _production_builds_running()
        _, info = netlify("GET", f"/sites/{site}", "read dashboard site")
        live = (info or {}).get("published_deploy") or {}
        if not running and d.get("state") == "ready":
            if live.get("created_at") and _ts(live["created_at"]) >= since:
                return
            if restarts >= 2:
                raise Fail("an older dashboard deploy keeps becoming live")
            restarts += 1
            deploy_id, since = start()
        SLEEP(15)
    raise Fail("the dashboard deploy did not finish within 20 minutes")


def dashboard_check():
    """What the LIVE dashboard deployment holds and whether it reads this source: (result, key_id, slots)."""
    url = origin_of(env("DASHBOARD_URL"), "DASHBOARD_URL") + "/api/pull-check"
    _, out = http("POST", url, {"authorization": f"Bearer {env('PULL_CHECK_TOKEN')}"}, {"source": env("SOURCE_KEY")},
                  label="dashboard pull check")
    out = out if isinstance(out, dict) else {}
    result = out.get("result") if out.get("result") in KNOWN_RESULTS else "unknown"
    kid = out.get("key_id") if isinstance(out.get("key_id"), str) and len(out["key_id"]) == 16 else None
    slots = sorted(s for s in (out.get("slots") or []) if s in ("1", "2"))
    return result, kid, slots


def expect_live(kid, slot=None, step=""):
    """Connectivity check after a change: the live dashboard holds key `kid` (None: no key yet) and, when it holds one,
    reads this source with it (in `slot`, if given). Retries briefly for propagation."""
    got = None
    for _ in range(6):
        got = dashboard_check()
        result, live_kid, slots = got
        if kid is None and result == "not_configured":
            return
        if kid is not None and live_kid == kid and result == "ok" and (slot is None or slot in slots):
            return
        SLEEP(10)
    result, live_kid, _ = got
    what = "a different key than expected" if live_kid != kid else f"result {result}"
    raise Fail(f"connectivity check after {step} failed: the live dashboard reports {what}")


KNOWN_RESULTS = {"ok", "unauthorized", "disabled", "unreachable", "unexpected_response", "source_error", "not_configured"}

RECOVERY = ("Every key the dashboard may be using is still accepted. Run rotate-reporting-key again: it resumes from "
            "the saved state and never replaces a key in use")


def rotate():
    """Two-slot rotation that can always be resumed.

    The Worker accepts keys in two slots (REPORTING_SECRET = 1, REPORTING_SECRET_NEXT = 2) and reports which slot
    matched. Before any change, the run waits until no dashboard build is running and asks the LIVE dashboard which
    key it holds (non-secret key id) and which slot accepts it. The rotation state saved on the dashboard site says
    which slot and key the dashboard SETTING holds (it may be ahead of the live deploy). Both slots are protected; the
    new key is only ever written to a slot neither uses. Steps, each followed by a connectivity check:
      1. new key into the free slot;      2. state saved, then the dashboard setting changed to the new key;
      3. dashboard deployed and live with the new key (checked by key id and slot);
      4. the other slot deleted: the previous key stops working.
    A run that finds the setting ahead of the live deploy resumes at step 3."""
    origin = origin_of(env("WORKER_URL"), "WORKER_URL")
    origin_of(env("DASHBOARD_URL"), "DASHBOARD_URL")
    for name in ("NETLIFY_AUTH_TOKEN", "NETLIFY_ACCOUNT_ID", "NETLIFY_DASHBOARD_SITE_ID", "PULL_CHECK_TOKEN", "SOURCE_KEY"):
        env(name)
    cfg, path, _ = build_config()

    wait_quiet()
    result, live_kid, live_slots = dashboard_check()
    if result not in ("ok", "not_configured") or (result == "ok" and not live_slots):
        raise Fail(f"the live dashboard does not read this source now (result {result}{'' if live_slots or result != 'ok' else ', no key slot reported: deploy the Worker first'}); nothing was changed")
    state = read_state()
    protected = set()
    if live_kid:
        protected.add(live_slots[0])                  # one slot that accepts the live key is kept
    if state and state["key_id"] != live_kid:
        protected.add(state["slot"])                  # the setting holds a key the live deploy does not have yet

    try:
        if len(protected) == 2:
            log("Resuming: the dashboard setting already holds a new key that is not live yet")
            slot, kid = state["slot"], state["key_id"]
        else:
            slot = OTHER[next(iter(protected))] if protected else "1"
            key = secrets.token_urlsafe(48)
            log(f"::add-mask::{key}")
            kid = key_id(key)
            wrangler(["secret", "put", SLOT_SECRET[slot]], path, stdin=key, label="add the new key to the Worker")
            expect_worker_reads(origin, key, slot)
            expect_no_key_refused(origin)
            expect_live(live_kid, step="adding the new key")
            log(f"1/4 New key added to Worker slot {slot}; the key in use still works")
            write_state(slot, kid)
            dashboard_set(env("DASHBOARD_SECRET_VAR"), key, secret=True, context="production")
            dashboard_set(env("DASHBOARD_URL_VAR"), origin, secret=False, context="all")
            expect_live(live_kid, step="changing the dashboard setting")
            log("2/4 Dashboard setting changed; the live dashboard still reads with the key in use")

        dashboard_redeploy_and_wait()
        result, now_kid, _ = dashboard_check()
        if now_kid != kid and len(protected) == 2:
            # The saved state was ahead of a setting change that never happened: clear it; nothing was removed.
            delete_state()
            raise Fail("the dashboard setting did not hold the pending key; the saved state was cleared")
        expect_live(kid, slot, step="deploying the dashboard")
        log(f"3/4 The live dashboard holds the new key and reads this source through slot {slot}")
    except Fail as e:
        raise Fail(f"{e}. {RECOVERY}")

    if OTHER[slot] in worker_filled_slots(cfg):
        wrangler(["secret", "delete", SLOT_SECRET[OTHER[slot]]], path, stdin="y\n", label="remove the previous key")
    if OTHER[slot] in worker_filled_slots(cfg):
        raise Fail("the previous key's slot is still filled. The live dashboard uses the new key; run rotate-reporting-key again")
    expect_live(kid, slot, step="removing the previous key")
    expect_no_key_refused(origin)
    log("4/4 Previous key removed; checked: the live dashboard reads with the new key and no key is refused")


def main():
    task = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        if task == "deploy":
            deploy()
        elif task == "rotate":
            rotate()
        else:
            raise Fail("usage: worker_ci.py deploy|rotate")
    except Fail as e:
        log(f"::error::{e}")
        sys.exit(1)
    except Exception as e:                             # never print a traceback: it can carry values
        log(f"::error::unexpected {type(e).__name__}")
        sys.exit(1)


if __name__ == "__main__":
    main()
