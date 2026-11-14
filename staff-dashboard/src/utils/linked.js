// FR-04 linked referrals: issue one LAB and/or PHARMACY token for the same visit.
// POST /api/visits/:id/linked-tokens { type, servicePointId? } once per selected type, one after the
// other (never in parallel), so each result — created display number or error — is known per type.
import { LINKED_TOKEN_TYPES } from './servicePoints.js';

export function linkedTypeLabel(type) {
  const info = LINKED_TOKEN_TYPES.find((t) => t.type === type);
  return info ? info.label : type;
}

/**
 * Explain a failed linked-token request for one type. Uses the server's message when it has one and
 * adds what it means for the doctor: 409 = this visit already has an active token of that type,
 * 403 = only the doctor whose OPD token is part of the visit may issue linked tokens (roles matrix).
 */
export function linkedErrorMessage(type, err) {
  const label = linkedTypeLabel(type).toLowerCase();
  const status = err && err.status;
  const server = err && err.message;
  if (status === 409) {
    return {
      message: server || `This visit already has an active ${label} token.`,
      hint: `No new ${label} token was issued; the patient keeps the existing one.`,
    };
  }
  if (status === 403) {
    return {
      message: server || 'You are not allowed to issue linked tokens for this visit.',
      hint: 'Only the doctor who saw the patient in this visit can issue linked tokens.',
    };
  }
  return { message: server || 'The token could not be issued.', hint: 'You can try again.' };
}

/**
 * Issue the selected linked tokens sequentially.
 * @param {{ issue: (visitId, type, servicePointId?) => Promise<object>, visitId: number,
 *           types: string[], servicePointIds?: Record<string, number|undefined>,
 *           onProgress?: (r: object) => void }} args
 * @returns {Promise<Array<{ type: string, ok: boolean, token?: object, status?: number, code?: string,
 *                           message?: string, hint?: string }>>}
 */
export async function issueLinkedTokens({ issue, visitId, types, servicePointIds = {}, onProgress }) {
  const results = [];
  for (const type of types) {
    if (onProgress) onProgress({ type, pending: true });
    let result;
    try {
      const token = await issue(visitId, type, servicePointIds[type] || undefined);
      result = { type, ok: true, token: token || null };
    } catch (err) {
      result = { type, ok: false, status: err && err.status, code: err && err.code, ...linkedErrorMessage(type, err) };
    }
    results.push(result);
    if (onProgress) onProgress(result);
  }
  return results;
}

/** One-line summary of the issued tokens for a toast, e.g. "LAB-003 at Lab counter and PHARMACY-012 issued." */
export function summariseIssued(tokens) {
  const list = (tokens || []).filter(Boolean);
  if (list.length === 0) return '';
  const parts = list.map((t) => {
    const where = t.servicePoint && t.servicePoint.name;
    return `${t.displayNumber || 'Token'}${where ? ` at ${where}` : ''}`;
  });
  return `${parts.join(' and ')} issued.`;
}
