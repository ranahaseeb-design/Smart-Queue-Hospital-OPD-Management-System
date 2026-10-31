# Smart OPD — Staff Dashboard

React web app for **doctors and OPD, laboratory and pharmacy staff** (Section 4.2.2 of the FYP
documentation). It shows only the queue of the service point the signed-in staff member is assigned to,
with the next patient prominent and one-click actions: **Call next, Start, Complete, Skip, Recall,
Transfer, Apply priority and Issue linked token**. Priority tokens are highlighted (emergency = red,
elderly / differently-abled = amber) and the screen updates live over Socket.IO.

It is a separate application from the Admin Dashboard (least privilege, Section 3.2): staff cannot change
master data or see other branches' analytics, and administrator / patient accounts are refused at sign-in.

Built strictly against [`docs/API_CONTRACT.md`](../docs/API_CONTRACT.md).

## Stack

- Vite 5 + React 18 (JavaScript), react-router-dom 6, socket.io-client 4
- Plain CSS with custom properties (white / teal clinical theme, large type, responsive down to tablet and usable on phones)
- Vitest for unit tests

## Setup

Requires Node.js 18+ (developed with Node 24 / npm 11).

```bash
cd staff-dashboard
npm install
cp .env.example .env      # optional: only needed to change the backend URL
npm run dev               # http://localhost:5173 (strict port)
```

The backend (`backend/`, port 4000) must be running for sign-in and queue data. Use a seeded staff account
from the contract, e.g. `doctor1@opd.test`, `lab1@opd.test` or `pharmacy1@opd.test` (password `Staff@123`,
development only).

### Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on port 5173 (`strictPort`) |
| `npm run build` | Production build to `dist/` |
| `npm run preview` | Serve the production build on port 5173 |
| `npm test` | Unit tests (Vitest) |

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `VITE_API_URL` | `http://localhost:4000` | Backend origin. REST calls go to `${VITE_API_URL}/api/...`. |
| `VITE_SOCKET_URL` | same as `VITE_API_URL` | Socket.IO origin, if it ever differs from the REST origin. |
| `VITE_HOSPITAL_TZ` | `Asia/Karachi` | Hospital time zone (the backend's `TZ`). "Waiting 12 min" / "called 3 min ago" counters and the "Updated" clock use it, so they are right even when the browser runs in another zone. |

Vite inlines these at build time, so rebuild after changing them. The backend must allow CORS from the
dashboard origin (`http://localhost:5173` in development).

## Screens (Table 4.19)

| Route | Screen |
|---|---|
| `/login` | **Login**: email or phone + password (`POST /api/auth/login`). Non-`STAFF` roles get a clear message and no session is stored. The JWT is kept in `localStorage`; any `401` on an authenticated call signs the user out with "Your session has expired". |
| `/` | Opens the only assigned service point, or the remembered one; otherwise goes to the picker. Shows a notice if the account has no assignment. |
| `/select` | **Service-point picker** (`GET /api/staff/service-points`) for staff assigned to more than one room or counter. The choice is remembered per user in `localStorage`. |
| `/queue/:servicePointId` | **My Queue**, a single screen with: **Now serving** card (token, patient name, status, priority badge, actions); a prominent **Call next** button; the **Waiting** list in server order with per-token *Priority* / *Transfer*; the **Skipped** list with *Recall*; the **Recently completed** list (last 5 completed today, newest first) with *Issue linked token* per row at OPD rooms; and **Today's summary** tiles (completed, waiting, skipped, average wait, average consult — "average service" at laboratory / pharmacy counters). |

Dialogs: **Skip** confirmation, **Transfer** (targets from `GET /api/staff/transfer-targets`, grouped by
OPD / Laboratory / Pharmacy with live waiting counts and a search box when the list is long),
**Priority** (level 0/1/2 + required reason, with quick-reason chips) and **Issue linked token** (Laboratory
or Pharmacy, optional counter; automatic = the backend picks the shortest queue). All dialogs trap focus,
close on Escape and return focus to the button that opened them. Outcomes are shown as toasts.

## How it maps to the requirements

| Requirement | Where |
|---|---|
| **FR-01** Authentication (staff side) | `src/auth/AuthContext.jsx`, `src/pages/LoginPage.jsx`, 401 handling in `src/api.js` |
| **FR-04** Linked lab / pharmacy tokens | `src/components/LinkedTokenModal.jsx` → `POST /api/visits/:visitId/linked-tokens`. Offered on the Now serving card and, after the consultation, on each row of `src/components/RecentlyCompletedList.jsx` (`recentlyCompleted` from the queue response). Only at OPD points (`canIssueLinkedTokens`). A `409` (the visit already has an active token of that type) is shown inside the dialog. |
| **FR-05** Real-time queue status | `src/socket.js` + `src/hooks/useQueue.js`: connects with `auth: { token }`, emits `subscribe { room: "sp:<id>" }` (again after every reconnect), re-fetches `GET /api/service-points/:id/queue` on `queue:updated`. A status dot shows Live / Connecting / Offline. While the socket is down the queue is polled every 15 s (the timer is not restarted by socket.io's reconnection attempts), it is re-fetched on reconnect and when the tab becomes visible again. |
| **FR-12** Staff queue operations | `src/pages/QueuePage.jsx`, `NowServingCard`, `WaitingList`, `SkippedList`, `TransferModal`. Call next → `POST /service-points/:id/call-next`; Start / Skip / Recall / Complete / Transfer → `POST /tokens/:id/<action>`. Buttons follow the token lifecycle: Start only when CALLED; Skip and Transfer only for CALLED (or WAITING, from the list); Complete for CALLED / IN_SERVICE; Call next and Recall are disabled while a token is open. A `409` (for example "a token is still open") is shown as an error toast. |
| **FR-13** Priority handling | `src/components/PriorityModal.jsx` → `POST /tokens/:id/priority { level, reason }`. A reason is required (stored as the `PRIORITY_SET` event note). The waiting list keeps the backend order (`priorityLevel DESC, issuedAt ASC`) and colours emergency rows red and elderly / differently-abled rows amber. |
| **NFR-01 / NFR-02** Responsiveness | Socket push plus coalesced re-fetches. Every REST call times out after 15 s so buttons never stay disabled. |
| **NFR-03** Usability | Large type and touch targets (≥ 44 px), one screen for the whole workflow, confirmation before Skip, `aria-label`s on every action, keyboard-operable dialogs. |
| **NFR-04** Security | JWT bearer auth, role check at sign-in and on session re-validation (`GET /api/auth/me`). The server still enforces assignments: a `403` on the queue shows "Not your service point". |

## Project structure

```
src/
  api.js                 REST client: base URL, bearer token, contract error envelope -> ApiError, 401 hook, timeout
  socket.js              Socket.IO connection + sp:<id> subscription
  config.js              VITE_API_URL / VITE_SOCKET_URL / VITE_HOSPITAL_TZ, polling interval
  auth/                  AuthContext (session), ServicePointsContext (assignments + remembered choice), RequireAuth
  hooks/                 useQueue (load + live updates + polling fallback), useNow (ticking clock)
  pages/                 LoginPage, StartPage, SelectServicePointPage, QueuePage
  components/            NowServingCard, WaitingList, SkippedList, RecentlyCompletedList, SummaryTiles, Transfer/Priority/LinkedToken modals,
                         Modal, ConfirmDialog, Toast, ConnectionStatus, PriorityBadge, AppHeader, Spinner
  utils/                 format (local-time parsing, durations, priority labels), servicePoints helpers, storage
  styles/index.css       Theme and layout
  __tests__/             Vitest unit tests
```

## Notes

- Contract datetimes have no zone suffix and are parsed as local time (`parseLocalDateTime`), so
  "waiting 12 min" counters are correct when the browser runs in hospital time (Asia/Karachi).
- The dashboard never re-orders the waiting list itself. It shows the backend's order, the single source
  of truth for FR-13 ordering.
- Linked-token counters are listed from `GET /api/staff/transfer-targets` (same-branch active points,
  filtered to LAB / PHARMACY). If that call fails, the dialog still works in "automatic" mode.
