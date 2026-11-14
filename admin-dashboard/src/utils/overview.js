// Pure helpers for the Live Overview (FR-15 live monitoring, FR-17 congestion alerts).
// Kept free of React so they can be unit tested.

const LEVEL_RANK = { CRITICAL: 2, HIGH: 1, NORMAL: 0 };

const isNum = (v) => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/**
 * Utilisation colour band for the department load matrix, from the live congestion ratio
 * (Eq. 6.5): emerald below 70 %, amber 70–85 %, crimson above 85 %. 'none' when unknown.
 */
export function utilisationBand(ratio) {
  if (!isNum(ratio)) return 'none';
  const r = Number(ratio);
  if (r < 0.7) return 'low';
  if (r <= 0.85) return 'mid';
  return 'high';
}

export const BAND_LABEL = { low: 'Below 70 %', mid: '70–85 %', high: 'Above 85 %', none: 'No capacity data' };

/**
 * Key used to dismiss an alert in the strip. One key per department, source and level, so a
 * dismissed department re-appears when it escalates (HIGH -> CRITICAL) or a live alert follows
 * a forecast one; the backend re-uses ids per department for live alerts and per hour for
 * forecast alerts, which would otherwise re-show the same department every hour.
 */
export function alertKey(a) {
  const where = a?.departmentId ?? a?.id ?? 'unknown';
  return `${where}|${a?.source || 'LIVE'}|${a?.level || 'HIGH'}`;
}

/**
 * Alerts for the sliding strip: HIGH / CRITICAL only, one per department (most severe first,
 * live before forecast, then the soonest forecast hour / newest live alert), minus dismissed
 * keys. Each item carries `count` = how many alerts were folded into it.
 */
export function stripAlerts(alerts, dismissed = new Set()) {
  const relevant = (Array.isArray(alerts) ? alerts : [])
    .filter((a) => a && (a.level === 'HIGH' || a.level === 'CRITICAL'));
  const sorted = [...relevant].sort((a, b) => (LEVEL_RANK[b.level] ?? 0) - (LEVEL_RANK[a.level] ?? 0)
    || (a.source === 'FORECAST') - (b.source === 'FORECAST')
    || (a.source === 'FORECAST'
      ? String(a.at ?? '').localeCompare(String(b.at ?? ''))
      : String(b.at ?? '').localeCompare(String(a.at ?? ''))));
  const byDept = new Map();
  for (const a of sorted) {
    const dept = a.departmentId ?? `alert-${a.id}`;
    const cur = byDept.get(dept);
    if (cur) cur.count += 1;
    else byDept.set(dept, { ...a, key: alertKey(a), count: 1 });
  }
  return [...byDept.values()].filter((a) => !dismissed.has(a.key));
}

/** Numeric series from the dashboard `trend` (null where the API has no value for that hour). */
export function trendSeries(trend, key) {
  if (!Array.isArray(trend)) return [];
  return trend.map((p) => (isNum(p?.[key]) ? Number(p[key]) : null));
}

/**
 * SVG paths for a sparkline. Null values break the line (no invented points). Returns null
 * when there are fewer than two numeric values, so no misleading flat line is drawn.
 */
export function sparkPath(values, width = 120, height = 32, pad = 2) {
  const list = Array.isArray(values) ? values : [];
  const nums = list.filter((v) => isNum(v)).map(Number);
  if (nums.length < 2) return null;
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const stepX = list.length > 1 ? (width - pad * 2) / (list.length - 1) : 0;
  const pt = (v, i) => {
    const x = pad + i * stepX;
    // Flat series sit in the middle instead of on the floor.
    const y = max === min ? height / 2 : pad + (1 - (v - min) / span) * (height - pad * 2);
    return [Math.round(x * 100) / 100, Math.round(y * 100) / 100];
  };
  const segments = [];
  let seg = [];
  list.forEach((v, i) => {
    if (isNum(v)) seg.push(pt(Number(v), i));
    else if (seg.length) { segments.push(seg); seg = []; }
  });
  if (seg.length) segments.push(seg);
  const line = segments.map((s) => s.map(([x, y], j) => `${j ? 'L' : 'M'}${x} ${y}`).join(' ')).join(' ');
  const area = segments
    .filter((s) => s.length > 1)
    .map((s) => `${s.map(([x, y], j) => `${j ? 'L' : 'M'}${x} ${y}`).join(' ')} L${s[s.length - 1][0]} ${height} L${s[0][0]} ${height} Z`)
    .join(' ');
  const lastSeg = segments[segments.length - 1];
  const [lx, ly] = lastSeg[lastSeg.length - 1];
  return { line, area, last: { x: lx, y: ly }, min, max };
}

/** Cubic ease-out used by the KPI count-up. */
export function easeOutCubic(t) {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
}

/** Count-up frame value between `from` and `to` at progress t (0..1). */
export function countUpValue(from, to, t) {
  if (!isNum(to)) return to;
  const a = isNum(from) ? Number(from) : 0;
  return a + (Number(to) - a) * easeOutCubic(t);
}

/** Departments visible in the matrix: live branch scope + department filter, worst load first. */
export function filterDepartments(departments, { branchId, departmentId } = {}) {
  return (Array.isArray(departments) ? departments : [])
    .filter((d) => !branchId || d.branchId === undefined || Number(d.branchId) === Number(branchId))
    .filter((d) => !departmentId || String(d.departmentId) === String(departmentId))
    .sort((a, b) => {
      const ra = isNum(a.congestionRatio) ? Number(a.congestionRatio) : -1;
      const rb = isNum(b.congestionRatio) ? Number(b.congestionRatio) : -1;
      return rb - ra || (Number(b.waiting) || 0) - (Number(a.waiting) || 0);
    });
}

/** One sentence for the polite live region, e.g. "Waiting now 12. In service 3. ...". */
export function kpiAnnouncement(items) {
  return (items || [])
    .filter((i) => isNum(i.value))
    .map((i) => `${i.label} ${Math.round(Number(i.value))}${i.unit ? ` ${i.unit}` : ''}`)
    .join('. ');
}
