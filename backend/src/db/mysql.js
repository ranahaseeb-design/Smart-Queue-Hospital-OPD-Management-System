'use strict';
/**
 * MySQL 8 driver (mysql2/promise pool) implementing the shared adapter API.
 * dateStrings keeps DATETIME/DATE/TIME as local strings (same as SQLite),
 * decimalNumbers returns DECIMAL/AVG/SUM as JS numbers.
 */
const { AsyncLocalStorage } = require('node:async_hooks');

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
  if (err && err.code === 'ER_DUP_ENTRY') err.code = 'DB_UNIQUE';
  return err;
}

/** Split a SQL script into statements (handles -- comments and ; terminators). */
function splitStatements(sqlText) {
  const withoutComments = sqlText
    .split(/\r?\n/)
    .map((line) => {
      const idx = line.indexOf('--');
      return idx >= 0 ? line.slice(0, idx) : line;
    })
    .join('\n');
  return withoutComments
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

class MysqlAdapter {
  constructor(cfg) {
    // Lazy require so SQLite-only installs never load mysql2.
    const mysql = require('mysql2/promise');
    this.mysql = mysql;
    this.client = 'mysql';
    this.cfg = cfg;
    this.pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      waitForConnections: true,
      connectionLimit: 10,
      dateStrings: true,
      decimalNumbers: true,
      supportBigNumbers: true,
      timezone: 'local',
      charset: 'utf8mb4',
    });
    this.als = new AsyncLocalStorage();
  }

  _executor() {
    const store = this.als.getStore();
    return store && !store.done ? store.conn : this.pool;
  }

  static async _query(executor, sql, params = []) {
    try {
      const [rows] = await executor.query(sql, params.map(normalizeParam));
      return rows;
    } catch (err) {
      throw wrapError(err);
    }
  }

  async query(sql, params) {
    const rows = await MysqlAdapter._query(this._executor(), sql, params);
    return Array.isArray(rows) ? rows : [];
  }

  async get(sql, params) {
    const rows = await this.query(sql, params);
    return rows[0];
  }

  async run(sql, params) {
    const res = await MysqlAdapter._query(this._executor(), sql, params);
    return { insertId: res.insertId, changes: res.affectedRows };
  }

  async exec(sqlText) {
    for (const stmt of splitStatements(sqlText)) {
      await MysqlAdapter._query(this._executor(), stmt, []);
    }
  }

  async lockRow(table, idColumn, id) {
    await this.query(`SELECT ${idColumn} FROM ${table} WHERE ${idColumn} = ? FOR UPDATE`, [id]);
  }

  async transaction(fn) {
    const outer = this.als.getStore();
    if (outer && !outer.done) return fn(outer.tx);

    const conn = await this.pool.getConnection();
    const store = { conn, tx: null, done: false };
    const tx = {
      client: 'mysql',
      inTransaction: true,
      query: async (sql, params) => {
        const rows = await MysqlAdapter._query(conn, sql, params);
        return Array.isArray(rows) ? rows : [];
      },
      get: async (sql, params) => (await tx.query(sql, params))[0],
      run: async (sql, params) => {
        const res = await MysqlAdapter._query(conn, sql, params);
        return { insertId: res.insertId, changes: res.affectedRows };
      },
      exec: async (sqlText) => {
        for (const stmt of splitStatements(sqlText)) await MysqlAdapter._query(conn, stmt, []);
      },
      lockRow: async (table, idColumn, id) => {
        await tx.query(`SELECT ${idColumn} FROM ${table} WHERE ${idColumn} = ? FOR UPDATE`, [id]);
      },
    };
    tx.transaction = async (inner) => inner(tx);
    store.tx = tx;
    try {
      await conn.beginTransaction();
      const result = await this.als.run(store, () => fn(tx));
      await conn.commit();
      return result;
    } catch (err) {
      try {
        await conn.rollback();
      } catch (_) {
        /* ignore */
      }
      throw err;
    } finally {
      store.done = true;
      conn.release();
    }
  }

  /** Run a script on a connection without a default database (CREATE DATABASE / USE). */
  async execAdmin(sqlText) {
    const conn = await this.mysql.createConnection({
      host: this.cfg.host,
      port: this.cfg.port,
      user: this.cfg.user,
      password: this.cfg.password,
      charset: 'utf8mb4',
    });
    try {
      for (const stmt of splitStatements(sqlText)) await conn.query(stmt);
    } finally {
      await conn.end();
    }
  }

  async close() {
    await this.pool.end();
  }
}

module.exports = { MysqlAdapter, splitStatements };
