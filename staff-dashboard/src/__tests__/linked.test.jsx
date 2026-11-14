// FR-04 linked referral drawer: sequential issuing per type with per-type 409 / 403 handling.
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ApiError } from '../api.js';
import { issueLinkedTokens, linkedErrorMessage, summariseIssued } from '../utils/linked.js';
import { ReferralChoices } from '../components/LinkedReferralDrawer.jsx';

const lab = { id: 90, displayNumber: 'LAB-003', servicePoint: { id: 20, name: 'Lab counter' } };
const pharmacy = { id: 91, displayNumber: 'PHARMACY-012', servicePoint: { id: 21, name: 'Pharmacy' } };

describe('issueLinkedTokens', () => {
  it('creates one token per selected type, one request after the other', async () => {
    const order = [];
    let inFlight = 0;
    const issue = vi.fn(async (visitId, type, servicePointId) => {
      inFlight += 1;
      expect(inFlight).toBe(1); // never parallel
      order.push([visitId, type, servicePointId]);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return type === 'LAB' ? lab : pharmacy;
    });
    const progress = [];
    const results = await issueLinkedTokens({
      issue,
      visitId: 17,
      types: ['LAB', 'PHARMACY'],
      servicePointIds: { PHARMACY: 21 },
      onProgress: (r) => progress.push(r.pending ? `${r.type}:pending` : `${r.type}:${r.ok}`),
    });
    expect(order).toEqual([
      [17, 'LAB', undefined],
      [17, 'PHARMACY', 21],
    ]);
    expect(results.map((r) => r.token.displayNumber)).toEqual(['LAB-003', 'PHARMACY-012']);
    expect(progress).toEqual(['LAB:pending', 'LAB:true', 'PHARMACY:pending', 'PHARMACY:true']);
  });

  it('keeps going after a 409 and reports each type on its own', async () => {
    const issue = vi.fn(async (visitId, type) => {
      if (type === 'LAB') throw new ApiError(409, 'CONFLICT', 'The visit already has an active LAB token');
      return pharmacy;
    });
    const [labResult, pharmacyResult] = await issueLinkedTokens({ issue, visitId: 17, types: ['LAB', 'PHARMACY'] });
    expect(labResult).toMatchObject({ type: 'LAB', ok: false, status: 409, message: 'The visit already has an active LAB token' });
    expect(labResult.hint).toMatch(/keeps the existing one/);
    expect(pharmacyResult).toMatchObject({ type: 'PHARMACY', ok: true });
  });

  it('explains a 403 (only the treating doctor may issue linked tokens)', async () => {
    const issue = async () => {
      throw new ApiError(403, 'FORBIDDEN', '');
    };
    const [r] = await issueLinkedTokens({ issue, visitId: 17, types: ['PHARMACY'] });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/not allowed/);
    expect(r.hint).toMatch(/Only the doctor who saw the patient/);
  });

  it('has defaults for other failures and summarises successes', () => {
    expect(linkedErrorMessage('LAB', new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server.')).message).toBe(
      'Cannot reach the server.',
    );
    expect(linkedErrorMessage('LAB', { status: 409 }).message).toBe('This visit already has an active laboratory token.');
    expect(summariseIssued([lab, pharmacy])).toBe('LAB-003 at Lab counter and PHARMACY-012 at Pharmacy issued.');
    expect(summariseIssued([])).toBe('');
  });
});

describe('ReferralChoices (drawer toggles)', () => {
  const render = (props) =>
    renderToStaticMarkup(<ReferralChoices selected={{}} results={{}} busy={false} onToggle={() => {}} {...props} />);

  it('offers LAB and PHARMACY as toggle buttons', () => {
    const html = render({ selected: { LAB: true } });
    expect(html).toContain('aria-label="Do not issue a laboratory token"');
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="Do not issue a laboratory token"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="Issue a pharmacy token"/);
  });

  it('shows the created display number per type and the reason for a failed one', () => {
    const html = render({
      selected: { LAB: true, PHARMACY: true },
      results: {
        LAB: { type: 'LAB', ok: true, token: lab },
        PHARMACY: { type: 'PHARMACY', ok: false, status: 409, message: 'Already active', hint: 'No new token.' },
      },
    });
    expect(html).toContain('LAB-003');
    expect(html).toContain('at Lab counter');
    expect(html).toContain('aria-label="Laboratory token issued"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Already active');
    expect(html).toContain('No new token.');
  });

  it('shows progress while a type is being issued', () => {
    const html = render({ selected: { PHARMACY: true }, results: { PHARMACY: { type: 'PHARMACY', pending: true } }, busy: true });
    expect(html).toContain('Issuing pharmacy token…');
  });
});
