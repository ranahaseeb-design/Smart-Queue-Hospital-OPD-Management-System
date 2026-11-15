// Patient-side location helpers: simulated areas (preset coordinates in Lahore), the haversine
// distance (Eq. 6.4, the same formula the backend scorer uses) and the congestion rule that makes
// the portal look for a faster branch before booking.

/** Simulated patient locations for demonstrations (approximate area centres, WGS84). */
export const AREAS = [
  { id: 'model-town', name: 'Model Town', lat: 31.4834, lng: 74.3256 },
  { id: 'johar-town', name: 'Johar Town', lat: 31.4697, lng: 74.2728 },
  { id: 'gulberg', name: 'Gulberg', lat: 31.516, lng: 74.3429 },
  { id: 'dha', name: 'DHA Phase 5', lat: 31.4627, lng: 74.4067 },
  { id: 'iqbal-town', name: 'Allama Iqbal Town', lat: 31.5089, lng: 74.2816 },
];

const EARTH_RADIUS_KM = 6371;
const rad = (deg) => (deg * Math.PI) / 180;

/** Great-circle distance in km (Eq. 6.4), 1 decimal; null when a coordinate is missing. */
export function haversineKm(a, b) {
  if (!a || !b) return null;
  const nums = [a.lat, a.lng, b.lat, b.lng].map(Number);
  if (nums.some((n) => !Number.isFinite(n))) return null;
  const [lat1, lng1, lat2, lng2] = nums;
  const dLat = rad(lat2 - lat1);
  const dLng = rad(lng2 - lng1);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h))) * 10) / 10;
}

/**
 * The portal looks for a faster branch when the chosen doctor's queue is this busy: predicted wait
 * over 25 min, more than 4 waiting, or the department's live load (Eq. 6.5) at 75 % or more.
 */
export const CONGESTION_RULE = { waitMinutes: 25, waiting: 4, loadPercent: 75 };

export function isCongested(doctor, department = null) {
  if (!doctor) return false;
  const wait = Number(doctor.estimatedWaitMinutes);
  const waiting = Number(doctor.queueLength);
  const load = Number(department?.loadPercent);
  return (
    (Number.isFinite(wait) && wait > CONGESTION_RULE.waitMinutes)
    || (Number.isFinite(waiting) && waiting > CONGESTION_RULE.waiting)
    || (Number.isFinite(load) && load >= CONGESTION_RULE.loadPercent)
  );
}

/**
 * What to recommend from GET /recommendations items (already sorted by the Eq. 6.3 score):
 *   best      — the top-scored option that saves at least 5 minutes (it may be another doctor in
 *               the same branch: a free room down the corridor beats a trip across town);
 *   otherBranch — when `best` is in the same branch, the top option at another branch, so the
 *               patient still sees the nearest less-crowded branch.
 * Both null when nothing saves 5 minutes.
 */
export function pickRecommendation(items, current) {
  const none = { best: null, otherBranch: null };
  if (!Array.isArray(items) || !current) return none;
  const currentWait = Number(current.estimatedWaitMinutes);
  if (!Number.isFinite(currentWait)) return none;
  const options = items
    .filter((item) => item.doctorId !== current.id)
    .map((item) => ({
      ...item,
      minutesSaved: Math.round(currentWait - Number(item.predictedWaitMinutes)),
      sameBranch: item.branchId === current.branchId,
    }))
    .filter((item) => item.minutesSaved >= 5);
  const best = options[0] || null;
  const otherBranch = best && best.sameBranch ? options.find((o) => !o.sameBranch) || null : null;
  return { best, otherBranch };
}

/** "Model rf-… (Random Forest)" vs the Eq. 6.2 fallback, for estimate labels. */
export function estimateSource(modelVersion) {
  if (!modelVersion) return { ai: false, label: 'No estimate yet' };
  if (modelVersion === 'baseline') return { ai: false, label: 'Queue formula (AI fallback)' };
  return { ai: true, label: `Random Forest · ${modelVersion}` };
}
