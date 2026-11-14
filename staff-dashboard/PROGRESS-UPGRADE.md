# Staff Dashboard — Upgrade 2026 progress (branch `upgrade/staff`)

Plan: `docs/UPGRADE_2026.md` (Decisions 1–9, "Staff Dashboard"). Contract: `docs/API_CONTRACT.md`.

## Done
- [x] M1 Theme (Decision 5): Dark ↔ Light toggle, default dark, `smartopd.theme`, inline script in `index.html`.

## Remaining
- [ ] M2 Split-screen console: queue panel (tabs, badges, escalation selector, row animations, aria-live),
      consultation stage (token, priority tag, stage, pace gauge, action bar, disabled reasons, shortcuts).
- [ ] M3 Linked referral drawer (LAB + PHARMACY toggles, sequential POSTs, per-type 409/403).
- [ ] M4 `/display` board (+ admin sign-in for `/display`, branch room socket, 3 s polling fallback).
- [ ] M5 Verify: vitest, build, README.
