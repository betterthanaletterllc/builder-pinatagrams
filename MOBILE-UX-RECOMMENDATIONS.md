# Mobile UX — diagnosis and recommendations for builder.pinatagrams.com

Written 2026-07-29 after a read-only source audit of `builder/src/app` plus live
re-testing of https://builder.pinatagrams.com at 375x812. This document is
self-contained: it assumes you have no other context. **Do not start
restructuring the layout before reading Section 1 — the headline finding is not
what the bug report says it is.**

---

## 1. Diagnosis

### 1.1 The reported catastrophic breakage is a test-rig artifact, not a site bug

The 2026-07-28 live test at 375x812 reported: landing renders in a ~40%-width
left column, unreadably small (~6px effective text), does not scroll; the
/design graphic chooser and label-split screens render the same way; the sticky
price bar renders tiny; step chips clipped off the right edge.

Those renders were real, and they reproduce — **in the Claude Browser pane**.
On 2026-07-29 I reproduced the identical corner-column render, then
cross-checked against DOM ground truth in the same tab. The two disagree:

| Probe (same moment, same tab) | Result |
| --- | --- |
| Screenshot | Content in a ~140px-wide left column at ~37% scale |
| `innerWidth` / `visualViewport` | 375 / scale 1.0 |
| `document.documentElement.scrollWidth` | 375 — **no horizontal overflow** |
| `.landing-overlay` `getBoundingClientRect()` | 0,0 375x812 — full viewport |
| Landing logo rect | x=100 w=176 — correctly centered in 375 |
| CTA button rect | x=20 w=335 — full-width mobile button |
| `elementFromPoint(200,400)` | hits `.landing-photo` — layout really is 375 wide |

The scale factor of the corrupt screenshot is 375/1004 ≈ 0.373: the pane's
compositor was still at its pre-resize ~1004px width, painting the (correct)
375px page into the top-left corner. Mouse/scroll input goes through the same
stale transform, which explains "does not scroll": a synthetic wheel at
screenshot-space (187,400) hit nothing and scrolled nothing, but the same wheel
at artifact-mapped (70,149) — i.e. page-space (187,400) — scrolled the landing
overlay normally (`scrollTop` 0 → 500). The overlay scrolls; the tester's
scroll events were landing outside the page.

Independent confirmations that the site itself is mobile-sane:

- The live HTML serves `<meta name="viewport" content="width=device-width,
  initial-scale=1"/>` (verified with curl against production 2026-07-29;
  Next.js App Router injects it — `src/app/layout.tsx` defines only
  `metadata`, no `viewport` export, which is fine).
- `document.documentElement.scrollWidth === 375` on every screen tested at a
  true 375px viewport: landing (overlay up and dismissed), `/design` choice
  step, graphic library, label-split (template) picker, canvas editor with a
  template open, `/cart`.
- There is no fixed-width stage, no missing responsive grid, no transform
  scaling. The candidate mechanisms are all explicitly handled in code:
  - Editor stage is measured, not fixed: `MAX_STAGE_WIDTH = 760` is only a cap;
    `stageW = max(280, min(760, wrapper.clientWidth))` with a `ResizeObserver`
    (`src/app/design/editor.tsx:46`, `:439-453`). Measured live at 375: stage
    347x169, fits.
  - Every desktop grid collapses: `.builder-grid` at ≤800
    (`src/app/globals.css:120-124`), `.editor-grid` at ≤1080 (`:912-916`),
    `.cart-grid` at ≤900 with `minmax(0,1fr)` specifically to prevent sideways
    scroll (`:2196-2202`), the flow rail/dock swap at ≥1024 (`:2356-2463`).
  - A dedicated ≤600px block exists with mobile-specific rules — 2-up style
    grid, full-width primary buttons, 16px inputs to prevent iOS focus-zoom,
    chips converted to a horizontal scroll row (`src/app/globals.css:2104-2185`).

Measured tap/type surfaces at a genuine 375px viewport (Chromium): style cards
169x197, choice cards 168x157, template cards 169x125, library search 347x49,
flow CTA full-width in a fixed 69px bottom stack, library tiles 110x54, step
chips 34px tall in a scrollable row. Small-target problems exist (Section 2.2)
— but nothing is 6px, nothing overflows, and the flow is operable.

**One-liner:** the builder's mobile layout is structurally sound at 375px
(verified against live DOM geometry); the observed "40% left column /
unscrollable / 6px text" render is a stale-compositor artifact of the browser
test rig after `resize_window` (screenshots and injected input both scaled by
375/1004 ≈ 0.373), so the real work is P1-level mobile polish — touch-target
sizes, safe-area insets, chip-row affordances, and touch ergonomics of the
canvas editor — not a structural rewrite.

### 1.2 Caveat and burden of proof

The re-test was Chromium DOM geometry, not a physical iPhone. Before treating
1.1 as final, run the real-device pass in Section 4.1. If a physical phone
*does* reproduce a scaled-down desktop render, the only mechanisms consistent
with this codebase would be viewport-meta absence in some render path (check
the served HTML of the exact failing URL) or a >375px-wide element forcing
overflow on a screen I didn't reach with hub data present (check
`document.documentElement.scrollWidth`). Everything below assumes 1.1 holds.

---

## 2. Recommendations, prioritized

### P0 — Re-verify on trustworthy tooling and pin the result with a test

Nothing structural should be rebuilt on the evidence we have; wrongly "fixing"
a working responsive layout is the biggest available regression risk.

1. Run Section 4.1 (real device + DevTools emulation) and record results.
2. When using the Claude Browser rig again: resize **before** first navigation,
   force-reload after any resize, and always cross-check a suspicious
   screenshot against `getBoundingClientRect()` + `scrollWidth` (Section 4.2
   has the paste-in probe). Treat screenshot/DOM disagreement as a rig fault.
3. Add a cheap regression guard: a Playwright (or similar) check that loads
   `/`, `/design?style=standard`, and `/cart` at 375x812 and asserts
   `document.documentElement.scrollWidth <= 375` and that `.landing-cta` /
   `.cta-btn` widths are ≥ 300px. This makes "mobile broke structurally"
   detectable without screenshots.

### P1 — Touch-target minimums (44px) — the biggest genuine gap

Apple HIG minimum is 44x44pt; several controls sit well under it. Measured at
375px and confirmed in CSS:

| Control | Current size | Where |
| --- | --- | --- |
| Step chips (`.chip`) | ~34px tall | `src/app/globals.css:1024-1034` (6px/14px padding, 13px font) |
| Editor slot corner buttons (`.slot-chips button`) | 26x26 | `src/app/globals.css:667-677` |
| Dock collapse toggle (`.dock-toggle`) | 30x30 | `src/app/globals.css:1312-1323` |
| `.btn.mini` (context bar "Edit text", "Replace photo") | ~24px tall | `src/app/globals.css:1010-1013` |
| `.btn.danger` (remove, context bar) | 4px/8px padding | `src/app/globals.css:421-424` |
| Color swatches (`.swatch`) | 22px (26px in context bar) | `src/app/globals.css:988-995`, `:484-486` |
| Flat/boxed segment (`.seg-btn`) | 36px tall | `src/app/globals.css:448-457` |
| Template switcher thumbs (`.tmpl-switch-btn`) | 52x33 | `src/app/globals.css:592-603` |
| Calendar days (`.cal-day`) | ~40px tall | `src/app/globals.css:1463-1472` |
| Header cart link (`.cart-link`) | ~37px tall | `src/app/globals.css:62-70` |

Fix pattern: inside the existing `@media (max-width: 600px)` block, give these
`min-height: 44px` / `min-width: 44px` (or extend the hit area with a
transparent `::after` inset of negative margin where visual size must stay
small, e.g. swatches and slot chips). The calendar can reach 44px by bumping
`.cal-day` padding to 12px 0.

### P1 — iOS safe-area on the flow's fixed bottom stack

`.edit-sheet` and `.mobile-checkout-bar` already pad with
`env(safe-area-inset-bottom)` (`src/app/globals.css:513`, `:2076`), but the
flow's main fixed stack does not: `.bottom-stack` (`:1228-1237`), `.cta-bar`
(`:1239-1245`), and `.build-dock` (`:1253-1259`) have plain padding. On
notched iPhones the primary CTA / dock strip sits against the home indicator.
Add `padding-bottom: calc(8px + env(safe-area-inset-bottom))` to whichever
element renders last in the stack (the dock, and the CTA bar when the dock is
hidden).

### P2 — Step chips row: keep, but add affordances

The chips row is the step navigation (`src/app/design/design-flow.tsx:
1243-1270`; landing version `src/app/page.tsx:100-122`). At ≤600px it becomes
`flex-wrap: nowrap; overflow-x: auto` (`src/app/globals.css:2177-2184`) —
measured `scrollWidth` 769 vs `clientWidth` 347, so ~55% of the steps are
offscreen. That is by design (it scrolls), and is what a screenshot reads as
"clipped off the right edge" — but today nothing tells the user, and the row
never auto-scrolls.

1. On step change, `scrollIntoView({inline:'center', behavior:'smooth'})` the
   `.chip.active` element (one effect in `design-flow.tsx`; the active chip is
   already marked `aria-current="step"`).
2. Add a right-edge fade (mask-image or a gradient pseudo-element on `.chips`)
   so the cut-off chip reads as "more here".
3. `scrollbar-width: none` on the row; the fade replaces the scrollbar signal.
4. Alternative worth considering: on phones collapse to "Step 3 of 7 — Message"
   with prev/next arrows; frees ~40px of vertical space and removes the scroll
   question entirely.

### P2 — Header economics on phones

The topbar (`src/app/layout.tsx:49-61`, `src/app/globals.css:39-52`) spends
~55px on logo + cart on every flow screen, on top of the fixed bottom stack
(69px measured, up to ~150px with the dock open) — on a 667px-tall SE-class
phone that is ~30% of the screen gone. Options, cheapest first: shrink topbar
padding to 8px within the flow; auto-hide the topbar on scroll-down inside
`/design` (CSS `position: sticky` + a small scroll listener); or drop the
header inside the flow entirely and rely on the step-1 chip as "back".
The cart link should also grow to 44px height (see P1 table).

### P2 — Per-step patterns

- **Style grid (landing):** already right — 2-up rows of ~170px photo cards at
  ≤600 (`src/app/globals.css:2115-2122`). No change.
- **Graphic chooser (library):** structure is sound (search 16px so no iOS
  zoom, `:1717-1728`; aisle chips scroll; shelf rows scroll). The weak point is
  tile size: `.library-grid` drops to `minmax(110px, 1fr)` at ≤600
  (`:2144-2147`) → 110x54px art tiles, measured. The art on these tiles is a
  2.05:1 label with text in it — at 54px tall the designs are hard to judge.
  Recommend 2-column (~165px) tiles on phones instead of 3-up, i.e.
  `grid-template-columns: repeat(2, 1fr)`; or keep 3-up but open a tap-to-zoom
  preview (the confirm screen already previews the pick on the box, so 2-up is
  the simpler, consistent answer).
- **Label-split picker (template chooser):** fine as-is — measured 169x125
  cards, 2-up, with real wireframe minis (`.tmpl-grid`,
  `src/app/globals.css:535-540`; heading "How should your label split?" in
  `src/app/design/editor.tsx` picker block). Only nit: `.tmpl-switch-btn`
  33px tall (P1 table).
- **Filling / add-ons / delivery / send-to:** already have mobile rules
  (fillings shrink media at ≤600 `src/app/globals.css:1697-1705`; addresses are
  full-width cards; floating-label inputs are 16px `:824-833`). Calendar day
  height is the only P1 item.

### P3 — The canvas editor on touch (serious section)

**Current state — better than the brief assumed.** The freeform-canvas v1 was
already replaced by a template editor (`src/app/design/editor.tsx:32-44`): the
label is a fixed layout of boxes; each box holds one photo (cover-filled) or
one auto-fitting text block. There are **no free drag/resize transform
handles** — nothing to grab, nothing to pinch. Interactions today:

- Tap a `+` box → "photo or text" menu (DOM overlays, `editor.tsx:962-985`;
  targets measured 172x169 — generous).
- Photos: tap to select; drag **along one axis only** to frame, clamped by
  `dragBoundFunc` (`editor.tsx:270-303`); state is a single scalar
  `offset` 0..1.
- Text: tap to select, **double-tap** to edit (`editor.tsx:350-353`); editing
  happens in a fixed bottom sheet with a 16px textarea (no iOS focus-zoom)
  (`editor.tsx:1129-1148`, `.edit-sheet` `src/app/globals.css:501-525`).
- Selected-slot tools: 26px corner chips on the slot (`editor.tsx:986-1027`)
  plus a sticky `.context-bar` (`editor.tsx:1073-1112`,
  `src/app/globals.css:468-482`).
- Phones default to "flat" view (label fills the width) instead of
  on-the-box compositing (`editor.tsx:436-447`, `NARROW = 520`).

This IS the "structured mobile composer" architecture, so the recommendation is
to **keep the model and fix its touch ergonomics**, not replace it:

1. **Bottom-sheet tool palette (replace the corner chips on phones).** The
   26px `.slot-chips` and the 24px `.btn.mini` context-bar buttons are the
   worst targets in the app. When a slot is selected on a narrow viewport,
   render the context bar as a fixed bottom sheet (the `.edit-sheet` pattern
   already exists and handles safe-area) with 44px buttons: Replace / Frame /
   Edit text / Color / Remove. Hide `.slot-chips` at ≤600 entirely.
2. **Slider/stepper for photo framing instead of relying on canvas drag.**
   The framing state is already one scalar (`slot.offset`, 0..1 —
   `editor.tsx:294-303`), so a range input in the tool sheet wires straight to
   `patchSlot(i, { offset })` with zero model change. This matters because
   axis-drag on touch fights page scroll: the Konva container computes
   `touch-action: auto` (verified live), so a vertical framing drag and a page
   pan are the same gesture and the browser can claim it — flaky drags on real
   devices. Keep drag for pointer/desktop; on touch make the slider primary.
3. **Pinch-zoom arbitration.** Today there is no pinch gesture in the editor
   (no zoom, no scale handles) — that is the right call; do not add one. Two
   guards: (a) leave `touch-action` permissive except while a photo slot is
   actively selected for framing (set `touch-action: none` on the stage
   container only in that state, restoring scroll otherwise); (b) the page
   itself remains pinch-zoomable because the viewport meta does not set
   `maximum-scale` / `user-scalable=no` — keep it that way (accessibility).
4. **Kill the double-tap dependency for text.** Double-tap is undiscoverable
   on touch and races the browser's double-tap-zoom heuristic. Single tap
   already selects (`editor.tsx:351`); make single tap on a *text* slot open
   the edit sheet directly (selection has no other purpose for text beyond the
   tools the sheet would show anyway). Keep dbl-click for desktop.
5. **44px minimums** for `.seg-btn`, swatches, and the editor CTA
   (`.editor-cta .btn` measured 39px tall) per P1.
6. **Alternative if editor friction persists in real usage:** a form-first
   composer — template picker, then a per-slot checklist ("Box 1 — photo:
   [Add photo]", "Box 2 — text: [type here]") with the canvas as a
   preview-only surface on phones. The my.betterthanaletter.com portal now has
   a template-composer step flow worth borrowing structure from:
   `C:/Users/natha/Claude/Projects/Pinatagrams/My/src/app/(portal)/orders/new`
   (see `steps.tsx`, `[orderId]/graphic/page.tsx`, `[orderId]/graphic/
   uploader.tsx`, `box-preview.tsx`). The builder's slot model maps 1:1 onto
   that pattern; the canvas stays for desktop.

### P3 — Smaller items

- `.slot-hint` bottoms out at 8px (`clamp(8px, 1.6vw, 12px)`,
  `src/app/globals.css:636-639`) — floor it at 10-11px.
- Hover-only affordances (`.library-card:hover` scale ring `:1847-1852`,
  `.style-card:hover`, chip hovers) do nothing on touch and can stick after
  tap; wrap them in `@media (hover: hover)`.
- The landing overlay locks body scroll by mutating
  `document.body.style.overflow` (`src/app/landing-overlay.tsx:56-63`) and
  restores on cleanup — correct, but if the overlay ever fails to unmount the
  page is dead. Consider `overscroll-behavior: contain` on `.landing-overlay`
  plus a `:has()`-based lock instead of imperative style mutation.
- `.has-dock` reserves a fixed 160px (`src/app/globals.css:1356-1359`) while
  the real stack ranges 69px (dock collapsed) to ~150px (open) — measure the
  stack with a ResizeObserver and set a CSS variable, or accept the slack.

---

## 3. Quick wins vs structural work

**Quick wins (CSS-only or one-liner JS; low risk, ship together):**
- 44px minimums for chips, cal-days, cart link, seg buttons, dock toggle,
  editor CTA (P1 table).
- Safe-area padding on `.bottom-stack`/`.cta-bar`/`.build-dock`.
- Active-chip `scrollIntoView` + right-edge fade on `.chips`.
- 2-column phone library grid.
- `@media (hover: hover)` guards; `.slot-hint` floor.

**Structural (component work; needs design judgment and device testing):**
- Bottom-sheet tool palette for the editor (replaces slot chips + context bar
  on phones) with the framing slider (P3.1-P3.2).
- Single-tap text editing (P3.4).
- Topbar auto-hide or removal inside the flow (P2).
- Step-chips → "Step N of M" pattern, if chosen over the scroll row (P2).
- Form-first composer fallback borrowing the My portal pattern (P3.6) — only
  if device testing shows the canvas still fails users.
- Playwright viewport regression guard (P0.3).

**Explicitly not recommended:** any rewrite of the flow grid, landing overlay,
or editor stage sizing to "fix mobile rendering" — the rendering is not broken
(Section 1).

---

## 4. How to verify

### 4.1 Real-device / trusted-emulation pass (do this first)

Devices/viewports: real iPhone (Safari) if at all possible, plus Chrome
DevTools device emulation at **320x568, 375x812, 390x844, 430x932, 768x1024**,
portrait; DPR 2-3.

Per viewport, walk: landing overlay → dismiss → style picker →
`/design?style=standard` → Graphic step → "Pick a graphic" (library) →
back → "Design your own" → label-split picker → editor (add a photo slot +
a text slot) → Message → Filling → Add-ons → Delivery (calendar) → Send to →
cart. Assert on each screen:

- No horizontal scroll: `document.documentElement.scrollWidth <=
  window.innerWidth`.
- Text ≥ 12px for anything that must be read; inputs ≥ 16px (iOS zoom).
- The fixed bottom stack visible and above the home indicator; footer links
  reachable (the `body:has(.bottom-stack)` clearance,
  `src/app/globals.css:765-769`).
- Focusing any input does not zoom the page (iOS).

### 4.2 The scroll bug and rig-artifact protocol

The 2026-07-28 "does not scroll / 40% column" report came from the Claude
Browser pane. To keep the rig honest:

1. Open a **fresh tab**, `resize_window` to mobile **before** the first
   navigation, then navigate.
2. If a screenshot looks scaled or cornered, run this probe and believe the
   DOM, not the screenshot:

```js
JSON.stringify({
  iw: innerWidth, vv: visualViewport.width, scale: visualViewport.scale,
  docSW: document.documentElement.scrollWidth,
  overlay: document.querySelector('.landing-overlay')?.getBoundingClientRect(),
  cta: (document.querySelector('.landing-cta')||document.querySelector('.cta-btn'))?.getBoundingClientRect(),
  hit: (e => e && {tag: e.tagName, cls: String(e.className).slice(0,40)})(document.elementFromPoint(innerWidth/2, innerHeight/2))
})
```
   Healthy at 375: `iw` 375, `docSW` 375, overlay/CTA rects spanning ~full
   width, center hit landing on real content. If a screenshot disagrees with
   these numbers, the rig is at fault — reload, or re-map coordinates by the
   ratio `iw / (apparent content width in screenshot)`.
3. Scroll checks must target elements, not the window: the landing overlay
   scrolls itself (`.landing-overlay { overflow-y: auto }`,
   `src/app/globals.css:1893-1900`) while body overflow is locked
   (`src/app/landing-overlay.tsx:56-63`). Verify with
   `document.querySelector('.landing-overlay').scrollTop` after a wheel/swipe
   over the overlay; also verify page scroll works on `/design` and that the
   chips row scrolls horizontally
   (`.chips` `scrollLeft` changes; `scrollWidth` ~769 vs `clientWidth` ~347 at
   375px).

### 4.3 Tap-target audit

Run on each screen (flags anything interactive under 44px):

```js
Array.from(document.querySelectorAll('button, a, input, select, textarea, [role=button]'))
  .map(el => ({el, r: el.getBoundingClientRect()}))
  .filter(({r}) => r.width > 0 && (r.width < 44 || r.height < 44))
  .map(({el, r}) => `${Math.round(r.width)}x${Math.round(r.height)} ${el.tagName}.${String(el.className).slice(0,40)}`)
```

Expected offenders before the P1 fixes: `.chip` (34px), `.slot-chips button`
(26px), `.dock-toggle` (30px), `.btn.mini`, `.swatch`, `.seg-btn` (36px),
`.tmpl-switch-btn` (33px), `.cal-day` (~40px), `.cart-link` (~37px). After the
fixes this list should be empty on every screen in the 4.1 walk.

### 4.4 Editor touch checks (real device)

- Page scrolls when the swipe starts on the canvas with nothing selected.
- With a photo slot selected, framing (slider once built; drag today) adjusts
  the crop without scrolling the page.
- Single tap opens text editing (after P3.4); the edit sheet's textarea does
  not trigger iOS zoom; the sheet clears the keyboard and the home indicator.
- Pinch-zoom of the page still works (no `maximum-scale` regression).
- Export still matches: after any editor change, "Use this design" → confirm
  screen preview → cart thumbnail all show the same composition.
