'use strict';
/** Minimal RFC 4180 CSV writer used by report exports (FR-16). */

function escapeCell(value) {
  if (value === null || value === undefined) return '';
  const s = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * @param {{key:string,label:string}[]} columns
 * @param {object[]} rows
 */
function toCsv(columns, rows) {
  const lines = [columns.map((c) => escapeCell(c.label)).join(',')];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeCell(row[c.key])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

module.exports = { toCsv, escapeCell };
