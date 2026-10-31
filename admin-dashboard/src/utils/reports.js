// Helpers for the Reports screen (FR-16): pick sensible chart axes from a generic report table.

export const REPORT_TYPES = [
  { value: 'doctor-consult', label: 'Average consultation time per doctor' },
  { value: 'department-traffic', label: 'Patient traffic per department' },
  { value: 'branch-utilization', label: 'Branch-wise OPD utilization' },
  { value: 'waiting-times', label: 'Waiting times' },
  { value: 'feedback', label: 'Patient feedback' },
];

const isNumeric = (v) =>
  typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

const isIdKey = (key) => /(^id$|Id$)/.test(key);

/** Columns whose non-empty values are all numeric (candidates for the chart metric). */
export function numericColumns(columns, rows) {
  return (columns || []).filter((c) => {
    if (isIdKey(c.key)) return false;
    const vals = (rows || []).map((r) => r[c.key]).filter((v) => v !== null && v !== undefined && v !== '');
    return vals.length > 0 && vals.every(isNumeric);
  });
}

/** First non-numeric column, used as the category axis (doctor, department, date ...). */
export function labelColumn(columns, rows) {
  const numeric = new Set(numericColumns(columns, rows).map((c) => c.key));
  return (columns || []).find((c) => !numeric.has(c.key) && !isIdKey(c.key)) || null;
}

/** Joins the given columns of a row into one category label, e.g. "Model Town · Cardiology". */
export function categoryLabel(row, cols) {
  const parts = (cols || [])
    .map((c) => row?.[c.key])
    .filter((v) => v !== null && v !== undefined && v !== '')
    .map(String);
  return parts.length ? parts.join(' · ') : '—';
}

/**
 * Text columns that make up the chart's category axis. Starts with the first non-numeric column
 * and, while its values repeat (several departments per branch in the department-traffic and
 * waiting-times reports), appends the next text columns until every row has a distinct label,
 * using at most `maxColumns` columns. Returns [] when the report has no text column.
 */
export function chartCategoryColumns(columns, rows, maxColumns = 3) {
  const numeric = new Set(numericColumns(columns, rows).map((c) => c.key));
  const text = (columns || []).filter((c) => !numeric.has(c.key) && !isIdKey(c.key));
  const picked = [];
  for (const col of text) {
    if (picked.length >= maxColumns) break;
    picked.push(col);
    const labels = (rows || []).map((r) => categoryLabel(r, picked));
    if (new Set(labels).size === labels.length) break;
  }
  return picked;
}

/** Filename from a Content-Disposition header, with a fallback. */
export function filenameFromDisposition(header, fallback) {
  if (!header) return fallback;
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(header);
  if (star) return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : fallback;
}
