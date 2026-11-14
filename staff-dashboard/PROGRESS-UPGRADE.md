# Staff Dashboard — Upgrade 2026 progress (branch `upgrade/staff`)

Plan: `docs/UPGRADE_2026.md` (Decisions 1–9, "Staff Dashboard"). Contract: `docs/API_CONTRACT.md`.

## Done
- [x] M1 Theme (Decision 5): Dark ↔ Light toggle, default dark, `smartopd.theme`, inline script in `index.html`.

- [x] M2 Split-screen console: `QueuePanel` (tabs + counts), `WaitingList` (badges, escalation selector →
      `PriorityModal initialLevel`, `useListTransition` row animations), aria-live via `utils/queueDiff.js`;
      `NowServingCard` = consultation stage (stage steps, `PaceGauge`, action bar from `utils/stageActions.js`
      with disabled reasons), keyboard shortcuts (`utils/shortcuts.js`, `ShortcutHelp`). Verified live on
      doctor1 (call → start → complete via N/S/C) and at 375 px (no overflow, stage first).

## Remaining
- [ ] M3 Linked referral drawer (LAB + PHARMACY toggles, sequential POSTs, per-type 409/403).
- [ ] M4 `/display` board (+ admin sign-in for `/display`, branch room socket, 3 s polling fallback).
- [ ] M5 Verify: vitest, build, README.
