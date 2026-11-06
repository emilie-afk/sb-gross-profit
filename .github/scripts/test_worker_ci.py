"""Tests for worker_ci.py. No network beyond local test servers. Run: python3 -m unittest discover -s .github/scripts

The rotation tests drive a model of the Worker (its reporting keys), the dashboard's Netlify site (settings, builds,
the live deploy) and the dashboard's pull check, and inject a failure at every step. After every run, successful or
not, the key held by the LIVE dashboard deploy must be one the Worker accepts.
"""
import contextlib
import http.server
import io
import json
import os
import stat
import sys
import tempfile
import threading
import unittest
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import worker_ci as ci  # noqa: E402

TOML = '''name = "demo-worker"
main = "src/index.js"
compatibility_date = "2026-09-01"
[[d1_databases]]
binding = "DB"
database_name = "demo"
database_id = "REPLACE_WITH_D1_DATABASE_ID"
migrations_dir = "migrations"
[vars]
ALLOWED_ORIGINS = "https://a.example"
FLAG = "false"
[env.staging]
name = "demo-staging"
'''
DB_ID = "0f1e2d3c-4b5a-6978-8091-a2b3c4d5e6f7"
PRIVATE = "very-private-value-4417"
SITE = "site-1"
DASH_KEY = "DEMO_REPORTING_KEY"
FAKE_ESBUILD = '''#!/usr/bin/env python3
import json, os, sys
meta = [a.split("=", 1)[1] for a in sys.argv if a.startswith("--metafile=")][0]
json.dump({"inputs": {p: {} for p in os.environ["FAKE_INPUTS"].split()}}, open(meta, "w"))
'''
FAKE_WRANGLER_FAILING = '''#!/usr/bin/env python3
import sys
print("✘ [ERROR] binding DB (''' + DB_ID + ''') value ''' + PRIVATE + ''' https://secret.example")
print("plain line ''' + PRIVATE + '''", file=sys.stderr)
sys.exit(3)
'''


def kid(k):
    return ci.key_id(k) if k else None


class Crash(BaseException):
    """Simulates the runner dying mid-step (not an Exception, so nothing in the script catches it)."""


class World:
    """A model of the Worker (two key slots), the dashboard's Netlify site (settings, builds, the live deploy) and the
    dashboard's /api/pull-check. After EVERY mutation it records a violation if any key the dashboard may be using
    (the live deploy's, any running build's, or the current setting's) is not accepted by the Worker."""

    def __init__(self, configured=True):
        self.slots = {"1": "K0"} if configured else {}
        self.worker_reports_slots = True
        self.no_key_status = 401
        self.env = {DASH_KEY: "K0"} if configured else {}
        self.deploys = {}
        self.seq = 0
        self.live = self.make_deploy(state="ready")
        self.fail = set()
        self.build_polls = 2
        self.interloper_pending = False
        self.interloper = None
        self.ops = []
        self.violations = []
        self.crash_at = None                          # crash on the Nth mutation
        self.mutations = 0
        self.applied = ["0001_init.sql", "0002_more.sql"]
        self.ignore_env_writes = False
        self.loose_slot_header = False                 # a faulty Worker that reports both slots for any key

    # ---- model
    def make_deploy(self, state="building", env=None):
        self.seq += 1
        d = {"id": f"d{self.seq}", "created": self.seq, "state": state, "env": dict(self.env if env is None else env), "polls": 0}
        self.deploys[d["id"]] = d
        return d["id"]

    def accepted(self):
        return {k for k in self.slots.values() if k}

    def live_key(self):
        return self.deploys[self.live]["env"].get(DASH_KEY)

    def keys_in_use(self):
        keys = {self.live_key(), self.env.get(DASH_KEY)}
        keys |= {d["env"].get(DASH_KEY) for d in self.deploys.values() if d["state"] == "building"}
        return {k for k in keys if k}

    def mutated(self, what):
        self.mutations += 1
        if self.crash_at is not None and self.mutations == self.crash_at:
            raise Crash(what)
        missing = self.keys_in_use() - self.accepted()
        if missing:
            self.violations.append(what)

    def iso(self, n):
        return f"2026-11-05T00:{n // 60:02d}:{n % 60:02d}Z"

    def advance(self):
        for d in list(self.deploys.values()):
            if d["state"] == "building" and d["id"] != self.interloper:
                d["polls"] += 1
                if d["polls"] >= self.build_polls:
                    d["state"] = "error" if "build" in self.fail else "ready"
                    if d["state"] == "ready" and not (self.interloper and d["id"] != self.interloper and self.deploys[self.interloper]["state"] == "building"):
                        self.live = d["id"]
                        self.mutated("publish")
        if self.interloper and self.deploys[self.interloper]["state"] == "building":
            self.deploys[self.interloper]["polls"] += 1
            if self.deploys[self.interloper]["polls"] >= self.build_polls + 2:
                self.deploys[self.interloper]["state"] = "ready"
                self.live = self.interloper            # the older build goes live last
                self.interloper = None
                self.mutated("publish older build")

    # ---- HTTP
    def http(self, method, url, headers=None, body=None, label="", ok=(200,), want_headers=False):
        headers = headers or {}
        bare = url.split("?")[0]
        self.ops.append((method, bare.rsplit("/", 2)[-2:], label))

        def out(status, data=None, h=None):
            if status not in ok:
                raise ci.Fail(f"{label}: HTTP {status}")
            return (status, data, h or {}) if want_headers else (status, data)
        if url.startswith(ci.CF_API):
            if bare.endswith("/settings"):
                b = [{"type": "plain_text", "name": "ALLOWED_ORIGINS", "text": "https://a.example"},
                     {"type": "plain_text", "name": "FLAG", "text": "false"}, {"type": "d1", "name": "DB", "id": DB_ID}]
                b += [{"type": "secret_text", "name": ci.SLOT_SECRET[s]} for s in self.slots]
                return out(200, {"success": True, "result": {"bindings": b}})
            if bare.endswith("/schedules"):
                return out(200, {"success": True, "result": {"schedules": []}})
            if bare.endswith("/workers/subdomain"):
                return out(200, {"success": True, "result": {"subdomain": "acct-sub"}})
            if bare.endswith("/query"):
                return out(200, {"success": True, "result": [{"results": [{"name": n} for n in self.applied]}]})
        if url.startswith(ci.NETLIFY_API):
            name = bare.split("/env/")[1] if "/env/" in bare else None
            if method in ("POST", "PATCH", "DELETE") and "/env" in bare:
                if "netlify" in self.fail:
                    return out(500)
                if method == "DELETE":
                    self.env.pop(name, None)
                elif not (self.ignore_env_writes and (name == DASH_KEY or (body and body[0]["key"] == DASH_KEY))):
                    if method == "POST":
                        for v in body:
                            self.env[v["key"]] = v["values"][0]["value"]
                    else:
                        self.env[name] = body["value"]
                self.mutated(f"setting {name or body[0]['key']}")
                return out(200 if method != "POST" else 201)
            if name is not None and method == "GET":
                if name not in self.env:
                    return out(404)
                return out(200, {"values": [{"context": "all", "value": self.env[name]}]})
            if bare.endswith(f"/sites/{SITE}/builds"):
                if self.interloper_pending:
                    self.interloper_pending = False
                    self.interloper = self.make_deploy(env={**self.env, DASH_KEY: self.live_key()})
                did = self.make_deploy()
                self.mutated("build")
                return out(201, {"deploy_id": did})
            if "/deploys/" in bare:
                self.advance()
                d = self.deploys[bare.rsplit("/", 1)[1]]
                return out(200, {"state": d["state"], "created_at": self.iso(d["created"])})
            if bare.endswith(f"/sites/{SITE}/deploys"):
                self.advance()
                return out(200, [{"context": "production", "state": d["state"], "created_at": self.iso(d["created"])} for d in self.deploys.values()])
            if bare.endswith(f"/sites/{SITE}"):
                return out(200, {"published_deploy": {"created_at": self.iso(self.deploys[self.live]["created"])}})
        if bare.endswith("/api/pull-check"):
            k = self.live_key()
            if not k:
                return out(200, {"result": "not_configured", "key_id": None, "slots": []})
            if "pull_check" in self.fail:
                return out(200, {"result": "unreachable", "key_id": kid(k), "slots": []})
            slots = sorted(s for s, v in self.slots.items() if v == k) if self.worker_reports_slots else []
            if self.loose_slot_header and slots:
                slots = ["1", "2"]
            return out(200, {"result": "ok" if slots or (k in self.accepted() and not self.worker_reports_slots) else "unauthorized",
                             "key_id": kid(k), "slots": slots})
        if bare.endswith("/v1/reports"):
            auth = headers.get("authorization", "")
            if not auth:
                return out(self.no_key_status)
            k = auth.removeprefix("Bearer ")
            slots = sorted(s for s, v in self.slots.items() if v == k)
            h = {"x-reporting-key-slot": ",".join(slots)} if slots and self.worker_reports_slots else {}
            return out(200 if slots else 401, None, h)
        raise AssertionError(f"unexpected request {method} {url}")

    # ---- wrangler
    def wrangler(self, args, config_path, stdin=None, label=""):
        self.ops.append(("wrangler", " ".join(args)))
        if label in self.fail:
            raise ci.Fail(f"{label} failed (exit 1)")
        slot = {v: k for k, v in ci.SLOT_SECRET.items()}.get(args[2]) if len(args) > 2 else None
        if args[:2] == ["secret", "put"]:
            self.slots[slot] = stdin
            self.mutated(f"put slot {slot}")
        elif args[:2] == ["secret", "delete"]:
            self.slots.pop(slot, None)
            self.mutated(f"delete slot {slot}")
        return ""


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = self.tmp.name
        wd = os.path.join(root, "worker")
        os.makedirs(os.path.join(wd, "src"))
        os.makedirs(os.path.join(wd, "migrations"))
        with open(os.path.join(wd, "wrangler.toml"), "w") as f:
            f.write(TOML)
        for m in ("0001_init.sql", "0002_more.sql"):
            with open(os.path.join(wd, "migrations", m), "w") as f:
                f.write("select 1;")
        self.runner_temp = os.path.join(root, "rt")
        os.makedirs(self.runner_temp)
        self.esbuild = os.path.join(root, "esbuild")
        with open(self.esbuild, "w") as f:
            f.write(FAKE_ESBUILD)
        os.chmod(self.esbuild, 0o755)
        self.env = {
            "WORKER_DIR": wd, "RUNNER_TEMP": self.runner_temp, "WRANGLER_BIN": "wrangler", "ESBUILD_BIN": self.esbuild,
            "TRIGGER_PATHS": "worker/** shared/**", "FAKE_INPUTS": "worker/src/index.js shared/calc.js",
            "CLOUDFLARE_API_TOKEN": "cf-token-secret", "CLOUDFLARE_ACCOUNT_ID": "acct-secret", "D1_DATABASE_ID": DB_ID,
            "WORKER_URL": "https://demo.example.workers.dev/", "PATH": os.environ["PATH"],
            "NETLIFY_AUTH_TOKEN": "nf-token-secret", "NETLIFY_ACCOUNT_ID": "nf-acct", "NETLIFY_DASHBOARD_SITE_ID": SITE,
            "DASHBOARD_URL": "https://dash.example", "PULL_CHECK_TOKEN": "mkd_pullchecktokensecret",
            "REPORTING_PATH": "/v1/reports", "REPORTING_AUTH": "bearer", "SOURCE_KEY": "plant_breakdown",
            "DASHBOARD_SECRET_VAR": DASH_KEY, "DASHBOARD_URL_VAR": "DEMO_API_URL",
        }
        self.w = World()
        self.cwd = os.getcwd()
        os.chdir(root)

    def tearDown(self):
        os.chdir(self.cwd)
        self.tmp.cleanup()

    def run_task(self, task, extra_env=None, real_wrangler=None):
        out = io.StringIO()
        e = {**self.env, **(extra_env or {})}
        if real_wrangler:
            e["WRANGLER_BIN"] = real_wrangler
        clock = iter(range(0, 10**9, 30))
        patches = [mock.patch.dict(os.environ, e, clear=True), mock.patch.object(ci, "http", self.w.http),
                   mock.patch.object(ci, "SLEEP", lambda s: None), mock.patch.object(ci, "NOW", lambda: next(clock)),
                   mock.patch.object(sys, "argv", ["worker_ci.py", task])]
        if not real_wrangler:
            patches.append(mock.patch.object(ci, "wrangler", self.w.wrangler))
        with contextlib.ExitStack() as st:
            for p in patches:
                st.enter_context(p)
            st.enter_context(contextlib.redirect_stdout(out))
            try:
                ci.main()
                code = 0
            except SystemExit as x:
                code = x.code
        return code, out.getvalue()

    def assert_clean_log(self, out, *extra):
        for s in ("cf-token-secret", "acct-secret", "nf-token-secret", "mkd_pullchecktokensecret", DB_ID, PRIVATE, SITE,
                  "dash.example", "demo.example", *extra):
            self.assertNotIn(s, out)


class Deploy(Base):
    def test_deploys_when_every_check_passes(self):
        code, out = self.run_task("deploy")
        self.assertEqual(code, 0, out)
        self.assertIn(("wrangler", "deploy"), self.w.ops)
        self.assertIn("Deployed", out)
        self.assert_clean_log(out)

    def test_config_is_private(self):
        self.run_task("deploy")
        path = os.path.join(self.runner_temp, "wrangler.ci.json")
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)
        with open(path) as f:
            cfg = json.load(f)
        self.assertNotIn("env", cfg)
        self.assertEqual(cfg["d1_databases"][0]["database_id"], DB_ID)

    def test_file_outside_trigger_paths_stops(self):
        code, out = self.run_task("deploy", {"FAKE_INPUTS": "worker/src/index.js shared/a.js lib/helper.js"})
        self.assertEqual(code, 1)
        self.assertIn("1 Worker source file(s) are outside", out)
        self.assertNotIn(("wrangler", "deploy"), self.w.ops)
        self.assertNotIn("lib/helper.js", out)

    def test_unapplied_migration_from_an_earlier_push_stops_every_deploy(self):
        self.w.applied = ["0001_init.sql"]               # 0002 was merged earlier and never applied
        for extra in ({}, {"ALLOW_SETTING_CHANGES": "true"}):
            code, out = self.run_task("deploy", extra)
            self.assertEqual(code, 1)
            self.assertIn("1 database migration(s) in the repository are not applied", out)
        self.assertNotIn(("wrangler", "deploy"), self.w.ops)
        self.w.applied.append("0002_more.sql")
        self.assertEqual(self.run_task("deploy")[0], 0)

    def test_changed_settings_named_only_when_public(self):
        orig = self.w.http

        def http(method, url, *a, **k):
            if url.endswith("/settings"):
                return 200, {"success": True, "result": {"bindings": [
                    {"type": "plain_text", "name": "ALLOWED_ORIGINS", "text": PRIVATE},
                    {"type": "plain_text", "name": "FLAG", "text": "false"},
                    {"type": "plain_text", "name": "PRIVATE_ONLY_NAME", "text": PRIVATE},
                    {"type": "kv_namespace", "name": "CACHE"}, {"type": "d1", "name": "DB", "id": DB_ID}]}}
            return orig(method, url, *a, **k)
        self.w.http = http
        code, out = self.run_task("deploy")
        self.assertEqual(code, 1)
        self.assertIn("variable ALLOWED_ORIGINS", out)
        self.assertIn("2 other setting(s) not named", out)
        self.assertNotIn("PRIVATE_ONLY_NAME", out)
        self.assertNotIn("CACHE", out)
        self.assert_clean_log(out)

    def test_wrong_database_always_stops(self):
        orig = self.w.http

        def http(method, url, *a, **k):
            if url.endswith("/settings"):
                return 200, {"success": True, "result": {"bindings": [{"type": "d1", "name": "DB", "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}]}}
            return orig(method, url, *a, **k)
        self.w.http = http
        code, out = self.run_task("deploy", {"ALLOW_SETTING_CHANGES": "true"})
        self.assertEqual(code, 1)
        self.assertNotIn(("wrangler", "deploy"), self.w.ops)
        self.assertNotIn("aaaaaaaa", out)

    def test_wrangler_failure_prints_step_and_exit_code_only(self):
        fake = os.path.join(self.tmp.name, "wrangler")
        with open(fake, "w") as f:
            f.write(FAKE_WRANGLER_FAILING)
        os.chmod(fake, 0o755)
        code, out = self.run_task("deploy", real_wrangler=fake)
        self.assertEqual(code, 1)
        self.assertIn("wrangler deploy failed (exit 3)", out)
        self.assertNotIn("ERROR] binding", out)
        self.assertNotIn("plain line", out)
        self.assert_clean_log(out, "secret.example")

    def test_wrangler_gets_no_netlify_credentials(self):
        fake = os.path.join(self.tmp.name, "wrangler")
        dump = os.path.join(self.tmp.name, "env.json")
        with open(fake, "w") as f:
            f.write(f"#!/usr/bin/env python3\nimport json, os\njson.dump(dict(os.environ), open({dump!r}, 'w'))\n")
        os.chmod(fake, 0o755)
        self.assertEqual(self.run_task("deploy", real_wrangler=fake)[0], 0)
        with open(dump) as f:
            seen = json.load(f)
        for k in ("NETLIFY_AUTH_TOKEN", "PULL_CHECK_TOKEN", "D1_DATABASE_ID", "WORKER_VAR_OVERRIDES"):
            self.assertNotIn(k, seen)
        self.assertEqual(seen["CLOUDFLARE_API_TOKEN"], "cf-token-secret")

    def test_unexpected_error_prints_no_detail(self):
        def boom(*a, **k):
            raise RuntimeError("detail " + DB_ID)
        with mock.patch.object(ci, "check_migrations", boom):
            code, out = self.run_task("deploy")
        self.assertEqual(code, 1)
        self.assertIn("unexpected RuntimeError", out)
        self.assert_clean_log(out)


class Rotate(Base):
    def fresh(self, **kw):
        self.w = World(**kw)

    def converge(self, runs=4):
        for _ in range(runs):
            code, out = self.run_task("rotate")
            if code == 0:
                return out
        self.fail("rotation did not complete after reruns:\n" + out)

    def assert_safe(self):
        self.assertEqual(self.w.violations, [], "a key the dashboard may use was not accepted at some point")

    def test_fresh_rotation(self):
        code, out = self.run_task("rotate")
        self.assertEqual(code, 0, out)
        key = self.w.slots["2"]
        self.assertEqual(set(self.w.slots), {"2"}, "the previous key's slot is removed")
        self.assertEqual(self.w.live_key(), key)
        self.assertEqual(json.loads(self.w.env["REPORTING_ROTATION_PLANT_BREAKDOWN"]), {"slot": "2", "key_id": ci.key_id(key)})
        w = [op[1] for op in self.w.ops if op[0] == "wrangler"]
        self.assertEqual(w, ["secret put REPORTING_SECRET_NEXT", "secret delete REPORTING_SECRET"])
        self.assertEqual([l for l in out.splitlines() if key in l], [f"::add-mask::{key}"])
        self.assertNotIn(ci.key_id(key), out)
        self.assertIn("4/4", out)
        self.assert_safe()
        self.assert_clean_log(out)

    def test_second_rotation_uses_the_other_slot(self):
        self.assertEqual(self.run_task("rotate")[0], 0)
        first = self.w.slots["2"]
        self.assertEqual(self.run_task("rotate")[0], 0)
        self.assertEqual(set(self.w.slots), {"1"})
        self.assertNotEqual(self.w.slots["1"], first)
        self.assertEqual(self.w.live_key(), self.w.slots["1"])
        self.assert_safe()

    def test_reviewer_repro_retry_after_failed_pull_check_never_replaces_the_live_key(self):
        # The dashboard went live with the new key in slot 2, then the final check failed.
        self.w.fail.add("pull_check_after_deploy")
        orig = self.w.http

        def http(method, url, *a, **k):
            if url.endswith("/api/pull-check") and "pull_check_after_deploy" in self.w.fail and self.w.live_key() not in ("K0", None):
                return (200, {"result": "unreachable", "key_id": kid(self.w.live_key()), "slots": []})
            return orig(method, url, *a, **k)
        self.w.http = http
        code, out = self.run_task("rotate")
        self.assertEqual(code, 1, out)
        live = self.w.live_key()
        self.assertEqual(self.w.slots.get("2"), live, "the dashboard is live on slot 2")
        self.w.fail.discard("pull_check_after_deploy")
        # Retry: slot 2 is in use and must not be overwritten.
        code, out = self.run_task("rotate")
        self.assertEqual(code, 0, out)
        puts = [op[1] for op in self.w.ops if op[0] == "wrangler" and op[1].startswith("secret put")]
        self.assertEqual(puts, ["secret put REPORTING_SECRET_NEXT", "secret put REPORTING_SECRET"], "the retry wrote slot 1, never slot 2")
        self.assertEqual(set(self.w.slots), {"1"})
        self.assertEqual(self.w.live_key(), self.w.slots["1"])
        self.assert_safe()

    def test_crash_after_any_mutation_then_rerun_is_always_safe(self):
        # Count the mutations of a clean run, then crash after each one in turn and rerun until done.
        probe = World()
        self.w = probe
        self.assertEqual(self.run_task("rotate")[0], 0)
        total = probe.mutations
        self.assertGreaterEqual(total, 6)
        for n in range(1, total + 1):
            with self.subTest(crash_at=n):
                self.fresh()
                self.w.crash_at = n
                with self.assertRaises(Crash):
                    self.run_task("rotate")
                self.w.crash_at = None
                self.converge()
                self.assertEqual(len(self.w.slots), 1)
                self.assertIn(self.w.live_key(), self.w.accepted())
                self.assertNotEqual(self.w.live_key(), "K0")
                self.assert_safe()

    def test_every_failure_keeps_every_key_in_use_accepted_and_reruns_finish(self):
        cases = {
            "add the new key to the Worker": lambda w: w.fail.add("add the new key to the Worker"),
            "Worker without slot reporting": lambda w: setattr(w, "worker_reports_slots", False),
            "Worker route open without a key": lambda w: setattr(w, "no_key_status", 200),
            "dashboard settings": lambda w: w.fail.add("netlify"),
            "dashboard build fails": lambda w: w.fail.add("build"),
            "dashboard build never finishes": lambda w: setattr(w, "build_polls", 10**9),
            "live dashboard cannot read": lambda w: w.fail.add("pull_check"),
            "remove the previous key": lambda w: w.fail.add("remove the previous key"),
        }
        for name, inject in cases.items():
            with self.subTest(name):
                self.fresh()
                inject(self.w)
                code, out = self.run_task("rotate")
                self.assertEqual(code, 1, out)
                self.assert_safe()
                self.assertIn(self.w.live_key(), self.w.accepted())
                self.assert_clean_log(out)
                self.w.fail.clear()
                self.w.worker_reports_slots, self.w.no_key_status, self.w.build_polls = True, 401, 2
                self.converge()
                self.assert_safe()
                self.assertEqual(len(self.w.slots), 1)
                self.assertNotIn("K0", self.w.accepted())

    def test_previous_key_kept_unless_the_live_dashboard_proves_the_new_key(self):
        # The setting write is silently lost: the deploy goes live with the OLD key, and the pull check is "ok"
        # (the old key is still accepted). The key id shows it is not the new key, so nothing is removed.
        self.w.ignore_env_writes = True
        code, out = self.run_task("rotate")
        self.assertEqual(code, 1, out)
        self.assertIn("K0", self.w.accepted())
        self.assertEqual(self.w.live_key(), "K0")
        self.assertIn("a different key than expected", out)
        self.assert_safe()
        # A rerun first clears the stale state (nothing removed), then a clean run finishes.
        self.w.ignore_env_writes = False
        self.converge()
        self.assert_safe()
        self.assertNotIn("K0", self.w.accepted())

    def test_key_id_alone_stops_retirement_even_if_slot_reporting_is_wrong(self):
        # Defence in depth: with a faulty slot header, the key id still shows the live dashboard has the old key.
        self.w.ignore_env_writes = True
        self.w.loose_slot_header = True
        code, out = self.run_task("rotate")
        self.assertEqual(code, 1, out)
        self.assertIn("K0", self.w.accepted())
        self.assert_safe()

    def test_older_overlapping_build_that_goes_live_last(self):
        self.w.interloper_pending = True
        code, out = self.run_task("rotate")
        self.assertEqual(code, 0, out)
        self.assert_safe()
        builds = [op for op in self.w.ops if op[0] == "POST" and op[1][-1] == "builds"]
        self.assertEqual(len(builds), 2, "built again after the older build went live")
        self.assertEqual(self.w.live_key(), next(iter(self.w.slots.values())))

    def test_first_rotation_when_the_dashboard_has_no_key(self):
        self.fresh(configured=False)
        code, out = self.run_task("rotate")
        self.assertEqual(code, 0, out)
        self.assertEqual(set(self.w.slots), {"1"})
        self.assertEqual(self.w.live_key(), self.w.slots["1"])
        self.assert_safe()

    def test_unreadable_state_changes_nothing(self):
        self.w.env["REPORTING_ROTATION_PLANT_BREAKDOWN"] = "not json"
        code, out = self.run_task("rotate")
        self.assertEqual(code, 1)
        self.assertEqual([op for op in self.w.ops if op[0] == "wrangler"], [])
        self.assertIn("unreadable", out)

    def test_failed_key_check_says_what_the_worker_answered_and_whether_the_url_is_this_worker(self):
        for url, hint in (("https://other-worker.acct-sub.workers.dev", "DIFFERENT Worker"),
                          ("https://demo-worker.acct-sub.workers.dev", "points to this Worker's workers.dev address"),
                          ("https://reports.example.com", "not this Worker's workers.dev address")):
            with self.subTest(url):
                self.fresh()
                self.w.no_key_status = 401
                orig = self.w.http

                def http(method, u, headers=None, *a, **k):
                    if u.endswith("/v1/reports") and headers:
                        return (404, None, {}) if k.get("want_headers") else (404, None)
                    return orig(method, u, headers, *a, **k)
                self.w.http = http
                code, out = self.run_task("rotate", {"WORKER_URL": url})
                self.assertEqual(code, 1)
                self.assertIn("last answer: HTTP 404, no slot reported", out)
                self.assertIn(hint, out)
                self.assertNotIn(url.split("//")[1], out)
                self.assertNotIn("acct-sub", out)
                self.assert_safe()

    def test_header_auth(self):
        self.env.update(REPORTING_AUTH="header:X-Reporting-Secret")
        orig = self.w.http

        def http(method, url, headers=None, *a, **k):
            if url.endswith("/v1/reports") and headers and "X-Reporting-Secret" in headers:
                headers = {"authorization": "Bearer " + headers["X-Reporting-Secret"]}
            return orig(method, url, headers, *a, **k)
        self.w.http = http
        self.assertEqual(self.run_task("rotate")[0], 0)

    def test_insecure_addresses_refused_before_any_change(self):
        for k, v in (("WORKER_URL", "http://demo.example"), ("DASHBOARD_URL", "http://dash.example"), ("WORKER_URL", "https://u:p@demo.example")):
            with self.subTest(k):
                self.w.ops.clear()
                code, out = self.run_task("rotate", {k: v})
                self.assertEqual(code, 1)
                self.assertEqual(self.w.ops, [])


class _Server(threading.Thread):
    def __init__(self, handler):
        super().__init__(daemon=True)
        self.hits = []
        outer = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def handle_one(self):
                outer.hits.append({k.lower(): v for k, v in self.headers.items()})
                handler(self)
            do_GET = do_POST = do_PATCH = handle_one
        self.httpd = http.server.HTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def run(self):
        self.httpd.serve_forever()

    def stop(self):
        self.httpd.shutdown()
        self.httpd.server_close()


class Redirects(unittest.TestCase):
    def test_no_redirect_ever_reaches_a_second_destination(self):
        second = _Server(lambda h: (h.send_response(200), h.end_headers(), h.wfile.write(b"{}")))
        second.start()
        for code in (301, 302, 303, 307, 308):
            def redirect(h, code=code):
                h.send_response(code)
                h.send_header("Location", second.url + "/stolen")
                h.end_headers()
            first = _Server(redirect)
            first.start()
            try:
                for method, body in (("GET", None), ("POST", {"a": 1})):
                    with self.subTest(code=code, method=method):
                        with self.assertRaises(ci.Fail) as ctx:
                            ci.http(method, first.url + "/x", {"authorization": "Bearer SECRET-TOKEN", "X-Reporting-Secret": "S"}, body, label="probe")
                        self.assertIn("redirect refused", str(ctx.exception))
            finally:
                first.stop()
        second.stop()
        self.assertEqual(second.hits, [], "no request (and so no credential) reached the redirect target")

    def test_requests_name_the_client_never_the_python_default(self):
        # Cloudflare answers Python-urllib's default User-Agent with 403 (error 1010) before the Worker runs.
        def ok(h):
            h.send_response(200)
            h.end_headers()
            h.wfile.write(b"{}")
        s = _Server(ok)
        s.start()
        try:
            ci.http("GET", s.url, {"x-reporting-secret": "k"}, label="probe")
            ci.http("POST", s.url, {"authorization": "Bearer t"}, {"a": 1}, label="probe")
        finally:
            s.stop()
        self.assertEqual(len(s.hits), 2)
        for h in s.hits:
            self.assertEqual(h.get("user-agent"), ci.USER_AGENT)
            self.assertNotIn("Python-urllib", h.get("user-agent", ""))

    def test_error_bodies_are_never_returned_or_printed(self):
        def fail(h):
            h.send_response(500)
            h.end_headers()
            h.wfile.write(PRIVATE.encode())
        s = _Server(fail)
        s.start()
        try:
            with self.assertRaises(ci.Fail) as ctx:
                ci.http("GET", s.url, label="read")
            self.assertEqual(str(ctx.exception), "read: HTTP 500")
        finally:
            s.stop()

    def test_cloudflare_and_netlify_calls_use_the_same_guarded_client(self):
        seen = []

        def fake(method, url, headers=None, body=None, label="", ok=(200,), want_headers=False):
            seen.append(url)
            return 200, {"success": True, "result": {}}
        with mock.patch.object(ci, "http", fake), mock.patch.dict(os.environ, {"CLOUDFLARE_API_TOKEN": "t", "CLOUDFLARE_ACCOUNT_ID": "a", "NETLIFY_AUTH_TOKEN": "n"}):
            ci.cf("GET", "/x", "x")
            ci.netlify("GET", "/y", "y")
        self.assertEqual(len(seen), 2)


if __name__ == "__main__":
    unittest.main()
