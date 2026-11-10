# Smart OPD Design System — "Clinical Calm"

One visual language for the Staff Dashboard and the Admin Dashboard: deep teal and ink on soft,
cool neutrals; Inter; generous whitespace; crisp cards with subtle depth. Calm and trustworthy
for clinical staff, dense enough for operational data. Light and dark themes come from one set
of semantic tokens ([tokens.css](tokens.css)).

## Principles

1. **The next action is obvious.** Each screen has one primary action, in `--color-primary`.
   Everything else is secondary or ghost. Staff should find "Call next" without looking.
2. **Status is never colour alone.** Every coloured state also has a word or icon
   (Emergency, Elderly, HIGH, Live), for colour-blind users and printouts.
3. **Numbers line up.** Token numbers, counts, minutes and KPIs use `font-variant-numeric:
   tabular-nums`. Token numbers use `--font-mono`.
4. **Calm surfaces, loud exceptions.** Neutral surfaces by default; strong colour is reserved
   for priority, congestion, errors and the primary action.
5. **Accessible by default.** WCAG 2.1 AA contrast in both themes, visible focus rings,
   44px touch targets on staff actions, keyboard reachable everything, reduced-motion honoured.

## Tokens

Use the semantic tokens only. Never hardcode hex/rgb, px font sizes, shadows or radii in
component CSS or JSX (`style={{}}` only for truly dynamic values such as a chart bar width).

| Group | Tokens | Notes |
|---|---|---|
| Surfaces | `--color-bg`, `--color-surface`, `--color-surface-raised`, `--color-surface-sunken`, `--color-surface-hover`, `--color-overlay` | Page = bg; cards/tables = surface; modals/menus = raised; inset areas, table headers = sunken |
| Lines | `--color-border`, `--color-border-strong`, `--color-divider` | Cards use border + `--shadow-xs`; inputs use border-strong |
| Text | `--color-text`, `-muted`, `-subtle`, `-disabled`, `-inverse` | Body = text; labels/meta = muted; placeholders/axis = subtle |
| Brand | `--color-primary`, `-hover`, `-active`, `--color-on-primary`, `--color-primary-soft`, `-soft-hover`, `-soft-text`, `--color-focus-ring` | |
| Status | `--color-{success,warning,danger,info}` + `-soft` (background) + `-text` (text on soft) | Badge = soft bg + text colour |
| Domain | `--color-priority-emergency(-soft)`, `--color-priority-elevated(-soft)`, `--color-congestion-{normal,high,critical}` | Emergency = danger; elderly / differently-abled = elevated (warning) |
| Charts | `--chart-1`…`--chart-6`, `--chart-grid`, `--chart-axis`, `--chart-reference` | Read at runtime with `getComputedStyle` so charts follow the theme |
| Type | `--font-sans`, `--font-mono`, `--text-xs`…`--text-display`, `--leading-*`, `--weight-*`, `--tracking-*` | Body 14px (`--text-base`) |
| Space | `--space-1`…`--space-16` (4px grid) | Card padding `--space-5`/`--space-6`; page gutter `--space-6` (`--space-4` on mobile) |
| Shape | `--radius-sm` (badges), `-md` (buttons, inputs), `-lg` (cards, modals), `-xl` (hero), `-full` (pills) | |
| Depth | `--shadow-xs` (cards), `-sm` (hover), `-md` (dropdowns, sticky), `-lg` (modals, toasts) | |
| Motion | `--duration-fast/base/slow`, `--ease-standard`, `--ease-emphasized` | Only opacity/transform/colour; zeroed under reduced motion |
| Layout | `--sidebar-width`, `--topbar-height`, `--content-max`, `--control-height(-sm/-lg)` | |

### Typography

Inter Variable, self-hosted with the npm package `@fontsource-variable/inter`, imported once in
`main.jsx` (no Google Fonts request, so it works offline on hospital networks).

| Role | Size | Weight | Extra |
|---|---|---|---|
| Display (now-serving token) | `--text-display` | bold | mono, tight tracking |
| Page title | `--text-xl` | semibold | tight tracking |
| Card title | `--text-lg` | semibold | |
| KPI value | `--text-2xl` | semibold | tabular-nums |
| Body / table cell | `--text-base` | regular | `--leading-normal` |
| Label / meta | `--text-sm` | medium | `--color-text-muted` |
| Overline (section label) | `--text-xs` | semibold | uppercase, `--tracking-caps`, muted |

## Theming

- Default light. Dark follows `prefers-color-scheme` unless the user chose a theme.
- **ThemeToggle** (both apps, in the header): cycles **System → Light → Dark**. The icon shows
  the current mode, and `aria-label` names the next one ("Switch to dark theme"). Store the
  choice in `localStorage` under `smartopd.theme`, wrapping every access in try/catch. Apply it
  as `document.documentElement.dataset.theme = 'light' | 'dark'`, and remove the attribute for
  System.
- Apply the stored theme **before React renders**, with a tiny inline script in `index.html`,
  to avoid a flash of the wrong theme.
- Charts, badges, focus rings and overlays must all be checked in both themes.

## Components

Each component lists its variants and required states. Every interactive element needs:
hover, `:focus-visible` (2px `--color-focus-ring` outline with 2px offset), active, disabled
(`--color-text-disabled`, no pointer events) and, where async, loading (inline spinner, label
kept, `aria-busy`).

| Component | Variants / sizes | Spec |
|---|---|---|
| **Button** | `primary`, `secondary` (surface + border-strong), `ghost`, `danger`, `soft` (primary-soft); `sm` / `md` / `lg` = control heights; `icon` (square) | radius-md, weight semibold, gap `--space-2` for icon + label. Staff action buttons are `lg` (48px). |
| **Badge / StatusChip** | `neutral`, `primary`, `success`, `warning`, `danger`, `info`; optional leading dot or icon | soft background + `-text` colour, radius-full, `--text-xs` semibold. Token statuses: WAITING neutral, CALLED info, IN_SERVICE primary, COMPLETED success, SKIPPED warning, CANCELLED / NO_SHOW / TRANSFERRED neutral. |
| **PriorityBadge** | `emergency` (danger), `elevated` (warning: elderly / differently-abled), none | Always shows the word. Waiting-list rows with priority get a 3px left border in the same colour. |
| **CongestionBadge** | NORMAL / HIGH / CRITICAL | congestion tokens; CRITICAL has a solid fill with inverse text. |
| **Card** | default, `interactive` (hover shadow-sm + border-strong), `hero` (radius-xl, primary-soft wash) | surface, border, radius-lg, shadow-xs. Header row: title + actions; optional overline. |
| **KPI tile** | default, with delta / with status | Overline label, KPI value, optional sub-text and a small icon in a primary-soft circle. |
| **Table** | default, compact | Header: sunken background, overline style. Rows: `--space-3` vertical padding, divider lines, hover = surface-hover. Numeric columns right-aligned with tabular-nums. Sticky header inside scroll containers. Empty state inside the table. |
| **Input / Select / Textarea** | `sm` / `md`; error | control height, radius-md, border-strong, surface background; focus = primary border + focus ring; label above (`--text-sm` medium); help or error text below (error in `--color-danger-text` with icon). |
| **Checkbox / Radio / Switch** | | Native inputs restyled with `accent-color: var(--color-primary)` at minimum. |
| **Modal / Dialog** | `sm` (400), `md` (560), `lg` (720) | raised surface, radius-lg, shadow-lg, overlay `--color-overlay`; header / body / footer (actions right: secondary then primary). Focus trapped, Escape closes, focus returns. |
| **Toast** | success, error, info | bottom-right (bottom-centre on mobile), raised, shadow-lg, 4px left accent, icon + text + dismiss; `role="status"`, errors `role="alert"`. |
| **Tabs / Segmented control** | | Underline tabs for page sections; segmented control for small filters such as report type or theme. |
| **Empty state** | | Icon in a soft circle, one-line title, one sentence, optional action. |
| **Skeleton** | | Shimmer blocks (sunken → surface-hover), replacing bare "Loading…" text. |
| **Connection indicator** | live / reconnecting / offline | Dot + word: Live (success, gentle pulse), Reconnecting (warning), Offline (danger). |
| **Sidebar nav** (admin) | | `--sidebar-width`; logo at top; grouped sections with overline headings (Operations, Master data, Insights, System). Active item: primary-soft background + primary-soft-text + 3px left bar. Collapses to an off-canvas drawer under 960px. |
| **Top bar** | | `--topbar-height`; page title / breadcrumb, branch filter (admin), connection indicator, ThemeToggle, user menu (name, role, sign out). |

## Patterns

- **Page layout (admin):** sidebar + top bar; content max `--content-max`, gutter `--space-6`.
  Page header = title + one-line description + primary action on the right.
- **Staff queue screen:** a two-column grid at ≥ 1100px.
  - Left: the hero **Now serving** card (display token number, patient name, priority badge,
    room, elapsed time, large action buttons), with **Call next** as the single dominant
    primary button, full width under it.
  - Right: Waiting list, Skipped, Recently completed, and the summary tiles above them.
  - One column below 1100px.
- **Forms:** one column inside modals; labels above; required fields marked; submit disabled
  while invalid; server errors shown inline at the top of the form.
- **Data loading:** skeletons first, then content; errors as an inline card with a Retry button.
- **Destructive actions** (skip, deactivate): danger or secondary button plus a confirm dialog
  that names the object.
- **Charts:** recharts with theme tokens read at runtime; gridlines `--chart-grid`; axis text
  `--chart-axis` `--text-xs`; tooltips styled as raised cards; peak hours highlighted with a
  warning-soft band, not colour alone.

## Accessibility checklist (both themes)

- Text contrast ≥ 4.5:1, large text and UI parts ≥ 3:1 (status badges: `-text` on `-soft`).
- Visible `:focus-visible` on every control; skip-to-content link; landmarks (`header`, `nav`,
  `main`).
- Staff action targets ≥ 44×44px.
- Live regions for toasts and queue changes; icon-only buttons have `aria-label`.
- `prefers-reduced-motion`: no pulse or slide animations.
