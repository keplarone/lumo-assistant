# Phase 3: Lumo design system

Source of truth: `packages/ui/src/styles/tokens.css` (tokens), `components.css` (component styles) and
`packages/ui/src/components` (React). This document explains the intent; the code wins if they disagree.

Space Studio was not available when this was written. When it is, its strongest ideas will be audited
against these principles and folded into the tokens rather than starting over.

## Principles

1. **A calm night with one warm light.** Lumo the owl is light in a night sky. The interface is the calm
   night around it: deep, near-neutral surfaces with a faint indigo tint from the mascot's body. Lumo's
   gold appears only where Lumo itself is present (the mark, the mascot, moments of completion), so it
   stays meaningful.
2. **Structure through spacing and surface, not lines.** Separation comes from a 4px spacing grid and three
   quiet surface steps. Borders are used only where an edge carries meaning (inputs, menus, cards that
   are clickable).
3. **One accent, used for intent.** Restrained blue marks the primary action, selection and focus. Nothing
   else is blue.
4. **Honest state.** Progress is shown as real progress (steps, counts, bytes) wherever it can be measured;
   indeterminate indicators are a last resort. Privacy-relevant states (microphone, screen, input control)
   use a dedicated "live" color that nothing else uses.
5. **Quick, quiet motion.** UI motion is 80–260 ms, eases out, and never overshoots. Expressive motion
   belongs to the mascot. Reduced-motion preferences collapse durations.

## Color

| Role     | Tokens                                                                            | Notes                                                                        |
| -------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Surfaces | `--lu-bg-sunken`, `--lu-bg`, `--lu-surface-1/2/3`, `--lu-surface-overlay`         | Dark: oklch L 0.135 → 0.252 at hue 275. Light: near-white with the same hue. |
| Lines    | `--lu-line-subtle`, `--lu-line`, `--lu-line-strong`                               | Translucent, so they read correctly on any surface.                          |
| Text     | `--lu-text`, `-secondary`, `-tertiary`, `-disabled`, `--lu-text-on-accent`        | Tertiary still meets 4.5:1 on every surface it is used on.                   |
| Accent   | `--lu-accent`, `-hover`, `-pressed`, `-text`, `-subtle`, `--lu-focus`             | Solid accent carries white text at ≥ 4.5:1.                                  |
| Lumo     | `--lu-lumen`, `--lu-lumen-subtle`, `--lu-lumen-text`, `--lu-aurora`               | From the mascot palette (#ffc65c, #7ff3ff). Brand use only.                  |
| Status   | `--lu-success`, `--lu-warning`, `--lu-danger(-solid, -text)`, each with `-subtle` |                                                                              |
| Privacy  | `--lu-live`                                                                       | Microphone, screen capture and input control indicators.                     |

Every pairing used by components is checked against WCAG 2.2 AA in both themes by
`packages/ui/test/contrast.test.ts` (text ≥ 4.5:1, primary text ≥ 7:1 on main surfaces, focus ring and
live indicator ≥ 3:1). The test reads `tokens.css` directly, so changing a token that breaks contrast
fails CI. The first run caught six real failures (white on the dark accent and danger buttons, and three
light-theme status colors), which were fixed before this document was written.

Themes: dark (default) and light, selected with `data-theme` on `<html>`. Apps resolve "follow system"
in script so each theme has a single definition. `prefers-contrast: more` strengthens all lines.

## Typography

| Use                         | Family              | Size / line height                  | Weight                    |
| --------------------------- | ------------------- | ----------------------------------- | ------------------------- |
| UI default                  | Montserrat Variable | 13 / 1.5                            | 400, 510 for labels       |
| Conversation text           | Montserrat Variable | 14 / 1.62                           | 400                       |
| Captions, mono labels       | IBM Plex Mono       | 11                                  | 400–500                   |
| Section title               | Montserrat Variable | 16 / 1.3                            | 600, tracking −0.012em    |
| Page title                  | Montserrat Variable | 20 / 1.3                            | 600                       |
| Display (greeting, website) | Montserrat Variable | 28 / 40 / 56 / 72, line height 1.15 | 600–700, tracking −0.03em |
| Code                        | IBM Plex Mono       | 0.92em of context                   | 400                       |

Montserrat (UI and display) and IBM Plex Mono (code and labels) are the only two families. All fonts are
self-hosted (`@fontsource` packages imported at each app entry), so the desktop app works offline.

## Space, size, shape

- Spacing: 4px grid (`--lu-space-1` = 4px … `--lu-space-24` = 96px) plus 2, 6 and 10px for optical fixes.
- Controls: 28 (sm), 32 (md, default), 40 (lg) px tall. Hit targets are never below 24×24.
- Radii: 4 (badges, keys), 6 (controls), 8 (menus, small cards), 12 (panels, dialogs), 16 (composer,
  floating window), full (pills, dots). Nothing larger than 16px except pills, which avoids the
  oversized-card look.
- Elevation: three shadows. In dark mode depth comes mainly from lighter surfaces; shadows add
  separation for menus (`--lu-shadow-2`) and dialogs (`--lu-shadow-3`).

## Motion

| Token                      | Value                           | Use                              |
| -------------------------- | ------------------------------- | -------------------------------- |
| `--lu-duration-instant`    | 80 ms                           | Press feedback                   |
| `--lu-duration-fast`       | 120 ms                          | Hover, color changes, menu close |
| `--lu-duration-base`       | 180 ms                          | Menu and popover open, switches  |
| `--lu-duration-slow`       | 260 ms                          | Dialogs, toasts, panels          |
| `--lu-duration-deliberate` | 420 ms                          | Large layout transitions         |
| `--lu-ease-standard`       | cubic-bezier(0.2, 0, 0, 1)      | Default                          |
| `--lu-ease-enter`          | cubic-bezier(0.05, 0.7, 0.1, 1) | Things appearing                 |
| `--lu-ease-exit`           | cubic-bezier(0.3, 0, 0.8, 0.15) | Things leaving                   |

With `prefers-reduced-motion: reduce`, durations collapse to 0–120 ms, spinners slow down and skeleton
shimmer stops. The mascot has its own calm mode (smaller amplitudes, no hops or turns, lower frame rate).

## Component states

Every interactive component defines:

| State           | Treatment                                                                       |
| --------------- | ------------------------------------------------------------------------------- |
| Rest            | Surface or accent fill per variant                                              |
| Hover           | One surface step lighter (or accent-hover); 120 ms                              |
| Pressed         | Scale 0.98 and pressed color; 80 ms                                             |
| Focus-visible   | 2px `--lu-focus` ring, 2px offset; keyboard only                                |
| Disabled        | 48% opacity, `not-allowed` cursor, removed from tab order where native          |
| Selected / open | Surface 3 (ghost) or accent-subtle; `aria-pressed` / `data-state`               |
| Loading         | Spinner replaces content in place, width preserved, `aria-busy`, clicks blocked |
| Invalid         | Danger border and an error message linked with `aria-describedby`               |

## Components (`@lumo/ui`)

Button (primary, secondary, ghost, danger; sm/md/lg; loading; icons; `asChild`), IconButton (label
required, tooltip with shortcut), Input, Textarea (auto-size), Field (label, description, error wiring),
Select, Switch, Checkbox, SegmentedControl (radio group with arrow keys), Tabs, Dialog, Menu, Popover,
Tooltip, Badge, StatusDot, Kbd, Card, Separator, Callout, EmptyState, Spinner, ProgressBar (determinate
or indeterminate), Skeleton, Toast. Menus, dialogs, popovers, selects, tabs and tooltips are built on
Radix primitives for keyboard and screen-reader behavior; their styling is entirely ours.

## Accessibility requirements

- WCAG 2.2 AA contrast, enforced by test.
- Every action is reachable by keyboard; focus is always visible; dialogs trap and restore focus.
- Icon-only buttons must have a label (the component requires it).
- Status changes that matter (run finished, approval needed, errors) are announced through live regions.
- Motion respects `prefers-reduced-motion`; nothing essential is conveyed by motion alone.
- The mascot is decorative to assistive technology except for its current state, exposed as a label.
- `forced-colors` and `prefers-contrast: more` are supported.

## Three.js usage rules

Three.js is for the mascot, task-state visualization, selected onboarding moments and the website's
storytelling. It is never used for forms, settings, lists or documents. Scenes render on demand, cap their
frame rate, stop when hidden, and have a static fallback.
