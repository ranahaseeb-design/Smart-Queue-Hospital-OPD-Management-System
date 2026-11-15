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

- [x] 2. Live Overview: `AlertStrip` (one per department, HIGH amber / CRITICAL pulsing crimson,
      dismiss per department+source+level in sessionStorage, "Simulate staffing fix →"),
      `LiveKpiTile` (count-up via `useCountUp`, reduced-motion aware) + `Sparkline` from `trend`,
      `LiveIndicator` (socket status; polling 15 s), `DepartmentMatrix` (utilisation bands,
      expandable doctors, graceful when `doctors` missing). Pure helpers in `utils/overview.js`.
      Styles in `src/styles/upgrade.css`. Polling fallback now 15 s (Decision 8).
      Tests: `utils/overview.test.js`, `pages/OverviewPage.test.jsx`.

- [x] 3. Forecasts: Area (arrivals Âh, dots coloured by congestion) vs dashed step capacity (Ch),
      `--chart-peak` crimson bands for peak OR shortfall hours, tooltip `ShortfallLine` with exact
      doctor-hours, "Staffing shortfall" KPI and Shortfall column. `utils/forecast.js` sums
      per-department shortfalls; falls back to the contract formula with `avgConsultMinutes`, else
      patients over capacity. Tests: `utils/forecast.test.js`, `pages/ForecastsPage.test.jsx`.

- [x] 4. Workload: `utils/whatIf.js` (parseTimeRange, resolveAvgConsult — forecast field, else
      mean of active doctors from /admin/doctors — backlogSeries, simulateExtraSession) with unit
      tests; recommendation cards with a `role="switch"` "+1 extra doctor session", animated mini
      chart (arrivals, dashed capacity, simulated capacity), count-up wait reduction, "Estimate"
      label and honest reasons when impossible. Forecasts fetched once per recommendation date.
      `?departmentId=` scrolls/focuses/highlights (glow), banner + Clear; "no recommendation" note.
      Forecasts page accepts `?departmentId=&date=` ("View forecast").
      Tests: `utils/whatIf.test.js`, `pages/WorkloadPage.test.jsx`.

## Remaining
- [ ] 5. Sidebar groups LIVE / INSIGHTS / MANAGE; Model Management scorecards, feature importances, retrain stepper
- [ ] 6. Polish: micro-interactions, skeletons, empty/error states, aria-live, keyboard, 44 px targets, 1280/768 px
- [ ] 7. Verify: vitest, build, README
