'use strict';
/**
 * Database adapter factory. DB_CLIENT selects the driver:
 *   - "sqlite" (default): Node's built-in node:sqlite, file SQLITE_PATH
 *   - "mysql": mysql2 pool against the canonical schema (database/schema.mysql.sql)
 *
 * Adapter API (identical for both drivers, and for the `tx` handle passed to transaction()):
 *   query(sql, params) -> rows[]
 *   get(sql, params)   -> row | undefined
 *   run(sql, params)   -> { insertId, changes }
 *   transaction(async (tx) => ...)
 *   lockRow(table, idColumn, id)   (SELECT ... FOR UPDATE on MySQL, no-op on SQLite)
 *
 * All SQL in this code base is portable: '?' placeholders, dates computed in JS,
 * no vendor-specific functions or upserts, booleans as 0/1, JSON stored as strings.
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

// Drop order respects foreign keys (children first).
const TABLES_DROP_ORDER = [
  'settings',
  'model_versions',
  'forecasts',
  'feedback',
  'notifications',
  'wait_predictions',
  'queue_events',
  'tokens',
  'appointments',
  'visits',
  'staff_assignments',
  'doctor_schedules',
  'doctors',
  'service_points',
  'departments',
  'users',
  'branches',
];

let instance = null;

function createDb(dbConfig = config.db) {
  if (dbConfig.client === 'mysql') {
    const { MysqlAdapter } = require('./mysql');
    return new MysqlAdapter(dbConfig);
  }
  if (dbConfig.client !== 'sqlite') {
    throw new Error(`Unsupported DB_CLIENT "${dbConfig.client}" (use sqlite or mysql)`);
  }
  const { SqliteAdapter } = require('./sqlite');
  return new SqliteAdapter(dbConfig.sqlitePath);
}

function getDb() {
  if (!instance) instance = createDb();
  return instance;
}

async function closeDb() {
  if (instance) {
    const db = instance;
    instance = null;
    await db.close();
  }
}

async function hasSchema(db) {
  try {
    await db.get('SELECT COUNT(*) AS n FROM settings', []);
    return true;
  } catch (_) {
    return false;
  }
}

/** Create all tables for the configured driver. */
async function createSchema(db) {
  if (db.client === 'sqlite') {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sqlite.sql'), 'utf8');
    await db.exec(sql);
    return;
  }
  // MySQL: run the canonical schema, adjusting the database name if DB_NAME differs.
  let sql = fs.readFileSync(config.db.mysqlSchemaPath, 'utf8');
  if (db.cfg.database !== 'smart_opd') {
    sql = sql
      .replace(/CREATE DATABASE IF NOT EXISTS smart_opd/g, `CREATE DATABASE IF NOT EXISTS \`${db.cfg.database}\``)
      .replace(/USE smart_opd;/g, `USE \`${db.cfg.database}\`;`);
  }
  await db.execAdmin(sql);
}

/** Drop all tables (MySQL) — SQLite resets by deleting the database file instead. */
async function dropSchema(db) {
  for (const table of TABLES_DROP_ORDER) {
    await db.run(`DROP TABLE IF EXISTS ${table}`, []);
  }
}

/** Delete the SQLite database file (and WAL side files). */
function deleteSqliteFile(file = config.db.sqlitePath) {
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    try {
      fs.unlinkSync(f);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
}

/** "?, ?, ?" for n parameters. */
function placeholders(n) {
  return new Array(n).fill('?').join(', ');
}

/** Batched multi-row INSERT (portable between MySQL and SQLite). */
async function insertMany(db, table, columns, rows, chunkSize = 400) {
  if (!rows.length) return;
  const rowPh = `(${placeholders(columns.length)})`;
  for (let i = 0; i < rows.length; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES ${chunk.map(() => rowPh).join(', ')}`;
    const params = [];
    for (const r of chunk) for (const v of r) params.push(v);
    await db.run(sql, params);
  }
}

/** JSON columns come back parsed from MySQL and as strings from SQLite. */
function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch (_) {
    return fallback;
  }
}

module.exports = {
  createDb,
  getDb,
  closeDb,
  hasSchema,
  createSchema,
  dropSchema,
  deleteSqliteFile,
  placeholders,
  insertMany,
  parseJson,
  TABLES_DROP_ORDER,
};
