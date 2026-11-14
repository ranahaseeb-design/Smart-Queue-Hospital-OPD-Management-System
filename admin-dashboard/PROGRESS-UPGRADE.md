# Admin Dashboard — Upgrade 2026, Phase 2 progress

Branch `upgrade/admin` (based on `5dcecf4` "Upgrade 2026 groundwork"). Binding docs:
`docs/UPGRADE_2026.md` (Decisions 1–9, "Admin Dashboard"), `docs/API_CONTRACT.md`,
`docs/design-system/DESIGN_SYSTEM.md`, `src/styles/tokens.css` (verbatim copy, do not edit).

New backend fields (`trend`, `departments[].doctors`, forecast `avgConsultMinutes` /
`shortfallDoctorHours`, model `featureImportances` / `baseline*`) are built on another branch:
the UI must degrade gracefully when they are missing. Component tests mock `api/client.js`.

## Done
- [x] 1. Theme: Dark <-> Light toggle, dark default, `smartopd.theme`, inline boot script in
      `index.html`, `utils/theme.js`, `ThemeToggle`, `useChartTheme` (no OS listener) + tests
      (`utils/theme.test.js` incl. the boot script, `components/ThemeToggle.test.jsx`).
      Test infra: jsdom + @testing-library/react (dev only), `src/test/dom.js`.

## Remaining
- [ ] 2. Live Overview: alert strip, animated KPI tiles + sparklines + Live indicator, department load matrix
- [ ] 3. Forecasts: arrivals vs dashed capacity, crimson peak/shortfall bands, shortfall tooltip
- [ ] 4. Workload: +1 doctor session what-if (pure util + tests), `?departmentId=` deep link
- [ ] 5. Sidebar groups LIVE / INSIGHTS / MANAGE; Model Management scorecards, feature importances, retrain stepper
- [ ] 6. Polish: micro-interactions, skeletons, empty/error states, aria-live, keyboard, 44 px targets, 1280/768 px
- [ ] 7. Verify: vitest, build, README
