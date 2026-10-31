'use strict';
/**
 * SQLite driver (Node's built-in node:sqlite DatabaseSync) implementing the
 * shared adapter API: query / get / run / transaction / exec / lockRow / close.
 *
 * DatabaseSync is synchronous and single-connection, so transactions are
 * serialised with a promise lock. AsyncLocalStorage tells us whether a call
 * comes from inside the running transaction (then it joins it) or from another
 * request (then it waits until the transaction finishes).
 */
const fs = require('node:fs');
const path = require('node:path');
const { AsyncLocalStorage } = require('node:async_hooks');
const { DatabaseSync } = require('node:sqlite');

function normalizeParam(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) {
    const { formatDateTime } = require('../utils/time');
    return formatDateTime(v);
  }
  return v;
}

function wrapError(err) {
  if (/UNIQUE constraint failed/i.test(err.message || '')) err.code = 'DB_UNIQUE';
  return err;
}

class SqliteAdapter {
  constructor(file) {
    this.client = 'sqlite';
    this.file = file;
    if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    if (file !== ':memory:') this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    this.statements = new Map();
    this.als = new AsyncLocalStorage();
    this.lock = Promise.resolve();
    this.active = null; // promise of the running transaction
  }

  prepare(sql) {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      if (this.statements.size > 500) this.statements.clear();
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  _query(sql, params = []) {
    try {
      return this.prepare(sql).all(...params.map(normalizeParam)).map((r) => ({ ...r }));
    } catch (err) {
      throw wrapError(err);
    }
  }

  _get(sql, params = []) {
    try {
      const row = this.prepare(sql).get(...params.map(normalizeParam));
      return row ? { ...row } : undefined;
    } catch (err) {
      throw wrapError(err);
    }
  }

  _run(sql, params = []) {
    try {
      const r = this.prepare(sql).run(...params.map(normalizeParam));
      return { insertId: Number(r.lastInsertRowid), changes: Number(r.changes) };
    } catch (err) {
      throw wrapError(err);
    }
  }

  async _ready() {
    // Outside the running transaction: wait for it to finish first.
    while (this.active && !this._inOpenTx()) {
      await this.active;
    }
  }

  _inOpenTx() {
    const store = this.als.getStore();
    return Boolean(store && !store.done);
  }

  async query(sql, params) {
    await this._ready();
    return this._query(sql, params);
  }

  async get(sql, params) {
    await this._ready();
    return this._get(sql, params);
  }

  async run(sql, params) {
    await this._ready();
    return this._run(sql, params);
  }

  async exec(sqlText) {
    await this._ready();
    this.db.exec(sqlText);
  }

  /** Row lock for read-modify-write sequences (no-op: SQLite transactions are serialised). */
  async lockRow() {}

  async transaction(fn) {
    const outer = this.als.getStore();
    if (outer && !outer.done) return fn(outer.tx); // nested: join the outer transaction

    const previous = this.lock;
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.lock = previous.then(() => current);
    await previous;
    while (this.active) await this.active; // safety

    this.active = current;
    const tx = this._txHandle();
    const store = { tx, done: false };
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const result = await this.als.run(store, () => fn(tx));
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        this.db.exec('ROLLBACK');
      } catch (_) {
        /* ignore rollback errors */
      }
      throw err;
    } finally {
      store.done = true;
      this.active = null;
      release();
    }
  }

  _txHandle() {
    const self = this;
    const tx = {
      client: 'sqlite',
      inTransaction: true,
      query: async (sql, params) => self._query(sql, params),
      get: async (sql, params) => self._get(sql, params),
      run: async (sql, params) => self._run(sql, params),
      exec: async (sqlText) => self.db.exec(sqlText),
      lockRow: async () => {},
    };
    tx.transaction = async (fn) => fn(tx);
    return tx;
  }

  async close() {
    try {
      this.db.close();
    } catch (_) {
      /* already closed */
    }
  }
}

module.exports = { SqliteAdapter };
