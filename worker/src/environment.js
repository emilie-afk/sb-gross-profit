/**
 * environment.js — C8 database-environment isolation guard
 * ========================================================
 * A Worker declares which environment it is (`SB_ENVIRONMENT` in wrangler.toml:
 * "production" or "staging"). Its D1 database is bound once, by an audited
 * admin call, to that same environment (settings key `database_environment`).
 *
 *   bound ≠ declared  → every request except /v1/health is refused (503) and the
 *                       Cron tick does nothing. A staging Worker that was pointed
 *                       at the production D1 (or the reverse) can neither read
 *                       nor write it.
 *   not bound yet     → reads are allowed; every write is refused (409) until
 *                       POST /v1/admin/environment/bind { environment, reason }.
 *   SB_ENVIRONMENT unset → the guard is inactive (unit tests, local dev only;
 *                       both wrangler.toml environments set it).
 *
 * The key is not settable through /v1/admin/settings, and a bound database
 * cannot be re-bound through the API.
 */
import { ApiError, json, readJson } from './http.js';
import { nowIso, atomic } from './db.js';
import { actorFor } from './actor.js';

export const ENV_KEY = 'database_environment';
const NAMES = new Set(['production', 'staging']);

async function boundEnvironment(db) {
  const r = await db.prepare('SELECT value FROM settings WHERE key = ?1').bind(ENV_KEY).first();
  if (!r) return null;
  try { return JSON.parse(r.value); } catch { return r.value; }
}

/** Throws when this request may not run against this database. */
export async function environmentGuard(env, { write }) {
  const want = env.SB_ENVIRONMENT;
  if (!want) return { active: false };
  if (!NAMES.has(want)) throw new ApiError(500, 'environment_invalid', 'SB_ENVIRONMENT must be "production" or "staging"');
  const bound = await boundEnvironment(env.DB);
  if (bound && bound !== want) {
    throw new ApiError(503, 'database_environment_mismatch', `This Worker is "${want}" but its D1 database belongs to "${bound}"; nothing is read or written`);
  }
  if (!bound && write) throw new ApiError(409, 'database_environment_unbound', 'Bind this D1 database to its environment first: POST /v1/admin/environment/bind { environment, reason }');
  return { active: true, environment: want, bound };
}

/** POST /v1/admin/environment/bind { environment, reason } — once per database, audited. */
export async function bindEnvironment(request, env) {
  const body = await readJson(request);
  const want = env.SB_ENVIRONMENT;
  if (!want || !NAMES.has(want)) throw new ApiError(409, 'environment_not_declared', 'This Worker has no SB_ENVIRONMENT; set it in wrangler.toml');
  if (body.environment !== want) throw new ApiError(400, 'bad_payload', `environment must be "${want}" (the Worker's declared environment)`);
  const reason = String(body.reason || '').trim();
  if (reason.length < 5) throw new ApiError(400, 'bad_payload', 'Binding the database needs a stated reason');
  const bound = await boundEnvironment(env.DB);
  if (bound === want) return json({ environment: want, bound: true, alreadyBound: true });
  if (bound) throw new ApiError(503, 'database_environment_mismatch', `This D1 database belongs to "${bound}"`);
  const actor = actorFor('admin_secret', body);
  const at = nowIso();
  await atomic(env.DB, [
    env.DB.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO NOTHING').bind(ENV_KEY, JSON.stringify(want), at),
    env.DB.prepare('INSERT INTO settings_audit (key, old_value, new_value, reason, actor_class, actor_label, at) VALUES (?1, NULL, ?2, ?3, ?4, ?5, ?6)')
      .bind(ENV_KEY, JSON.stringify(want), reason, actor.cls, actor.label, at),
  ]);
  if ((await boundEnvironment(env.DB)) !== want) throw new ApiError(409, 'database_environment_mismatch', 'Another bind happened first');
  return json({ environment: want, bound: true });
}
