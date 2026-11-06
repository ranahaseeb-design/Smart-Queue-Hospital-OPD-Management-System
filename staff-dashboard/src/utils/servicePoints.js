// Pure helpers around service points and transfer targets (no React, easy to unit test).

/**
 * Decide which service point to open straight after sign-in (Section 4.2.2).
 * - exactly one assigned point  -> that point
 * - remembered choice still assigned -> the remembered point
 * - otherwise null (the staff member must pick one)
 * @param {Array<{id:number}>} points  GET /api/staff/service-points
 * @param {string|number|null} rememberedId
 * @returns {number|string|null}
 */
export function pickInitialServicePoint(points, rememberedId) {
  const list = Array.isArray(points) ? points : [];
  if (list.length === 0) return null;
  if (list.length === 1) return list[0].id;
  if (rememberedId != null && rememberedId !== '') {
    const match = list.find((p) => String(p.id) === String(rememberedId));
    if (match) return match.id;
  }
  return null;
}

/**
 * Linked tokens (FR-04) are issued by doctors (roles matrix, Section 3.2) from OPD consultation
 * rooms only; the backend answers 403 for other staff.
 * @param {string} servicePointType
 * @param {{doctorId?: number|null}|null} user  the signed-in user (contract User shape)
 */
export function canIssueLinkedTokens(servicePointType, user) {
  return servicePointType === 'OPD' && Boolean(user && user.doctorId);
}

/**
 * Doctors may only operate their own patients' OPD tokens (the backend answers 403 otherwise).
 * A room can hold another doctor's tokens (e.g. a room shared between morning and evening sessions),
 * so those rows are shown read-only instead of offering actions that are bound to fail.
 * @param {{doctorId?: number|null}} token  QueueToken
 * @param {string} servicePointType
 * @param {{doctorId?: number|null}|null} user
 */
export function canOperateToken(token, servicePointType, user) {
  if (servicePointType !== 'OPD' || !user || !user.doctorId) return true;
  if (!token || token.doctorId == null) return true;
  return Number(token.doctorId) === Number(user.doctorId);
}

/** Linked token types offered by the backend (POST /api/visits/:id/linked-tokens). */
export const LINKED_TOKEN_TYPES = [
  { type: 'LAB', label: 'Laboratory', description: 'Diagnostic tests in the branch laboratory' },
  { type: 'PHARMACY', label: 'Pharmacy', description: 'Medicine collection at the branch pharmacy' },
];

/** Transfer targets (GET /api/staff/transfer-targets) of one service-point type, shortest queue first. */
export function targetsOfType(targets, type) {
  const list = Array.isArray(targets) ? targets : [];
  return list
    .filter((t) => t.type === type)
    .slice()
    .sort((a, b) => (Number(a.waiting) || 0) - (Number(b.waiting) || 0) || String(a.name).localeCompare(String(b.name)));
}

const TYPE_ORDER = { OPD: 0, LAB: 1, PHARMACY: 2 };

/**
 * Group transfer targets by type (OPD rooms first) and filter them by free text
 * (room name, doctor name or specialty).
 * @returns {Array<{ type: string, items: object[] }>}
 */
export function groupTransferTargets(targets, query = '') {
  const q = String(query || '').trim().toLowerCase();
  const list = (Array.isArray(targets) ? targets : []).filter((t) => {
    if (!q) return true;
    return [t.name, t.doctorName, t.specialty, t.type]
      .filter(Boolean)
      .some((v) => String(v).toLowerCase().includes(q));
  });
  const groups = new Map();
  list.forEach((t) => {
    if (!groups.has(t.type)) groups.set(t.type, []);
    groups.get(t.type).push(t);
  });
  return Array.from(groups.entries())
    .sort(([a], [b]) => (TYPE_ORDER[a] ?? 9) - (TYPE_ORDER[b] ?? 9))
    .map(([type, items]) => ({
      type,
      items: items.slice().sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true })),
    }));
}

/**
 * Why a transfer target cannot be chosen, or null when it can. The backend rejects a transfer to
 * an OPD room without a doctor scheduled today (doctorId null in the targets list).
 */
export function transferTargetUnavailableReason(target) {
  if (target && target.type === 'OPD' && target.doctorId == null) return 'No doctor today';
  return null;
}

/** One-line description of a transfer target for lists and toasts. */
export function describeTarget(target) {
  if (!target) return '';
  const parts = [target.name];
  if (target.doctorName) parts.push(target.doctorName);
  if (target.specialty) parts.push(target.specialty);
  return parts.filter(Boolean).join(' · ');
}
