/**
 * A minimal Cloudflare D1 stand-in over node:sqlite, for tests only.
 * Implements the surface the Worker uses: prepare().bind().first()/all()/run(),
 * batch() (atomic), exec(). Foreign keys are on, as in D1.
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const norm = v => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v);

class Stmt {
  constructor(db, sql, params = []) { this.db = db; this.sql = sql; this.params = params; }
  bind(...params) { return new Stmt(this.db, this.sql, params.map(norm)); }
  _st() { return this.db.prepare(this.sql); }
  async first(col) {
    const row = this._st().get(...this.params);
    if (!row) return null;
    const plain = { ...row };
    return col ? plain[col] : plain;
  }
  async all() { return { success: true, results: this._st().all(...this.params).map(r => ({ ...r })), meta: {} }; }
  async run() {
    const r = this._st().run(...this.params);
    const size = this.db.prepare('SELECT page_count * page_size AS s FROM pragma_page_count(), pragma_page_size()').get().s;
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid), size_after: Number(size) } };
  }
  _runSync() { return this._st().run(...this.params); }
}

export class D1Shim {
  constructor() { this.db = new DatabaseSync(':memory:'); this.db.exec('PRAGMA foreign_keys = ON'); }
  prepare(sql) { return new Stmt(this.db, sql); }
  /** Test hook: make the next batch fail at the first statement whose SQL matches. */
  failNextBatchAt(re, afterRollback = null) { this._failAt = re; this._afterFail = afterRollback; return this; }
  async batch(stmts) {
    this.db.exec('BEGIN');
    try {
      const out = stmts.map(s => {
        if (this._failAt && this._failAt.test(s.sql)) { this._failAt = null; throw new Error('injected failure (test)'); }
        const r = s._runSync(); return { success: true, meta: { changes: Number(r.changes) } };
      });
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      if (this._afterFail) { const f = this._afterFail; this._afterFail = null; f(this.db); }   // runs outside the rolled-back transaction
      throw e;
    }
  }
  async exec(sql) { this.db.exec(sql); return { count: 1 }; }
  migrate(dir) {
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) this.db.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    return this;
  }
}
