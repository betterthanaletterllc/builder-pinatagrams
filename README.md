# builder.pinatagrams.com

Customer-facing custom piñata design builder. NEW app on the customer stack
(GitHub → Vercel → Neon), sibling to `quote/` and `gift/` — deliberately NOT
in the internal ops monorepo. Full architecture + decision history live in the
project memory / ROADMAP.md (workstream #7).

## Where it sits

| Concern | Home |
|---|---|
| Catalog, availability, pricing numbers | **the hub** (admin.betterthanaletter.com) — this app reads `/api/public/*` only, never COGS |
| Pricing math at checkout | server-side here, recomputed from hub numbers — the client sends a selection, never a price |
| Design documents (saved designs) | `builder_*` schema on the customer Neon instance (later milestone) |
| Flattened print art | Vercel Blob, public https URLs handed to Paper as the `_frontGraphic` line-item property |
| Orders | Shopify draft orders (Admin API, client-credentials grant via the admin.btal dev-dashboard app) |
| Fulfillment | Paper (internal monorepo) — meets this app ONLY at Shopify order → webhook → print |
| Brand identity (colors, logos, fonts) | **`design-system/`** (github.com/betterthanaletterllc/pinatagrams-design-system) — official tokens in `colors_and_type.css` (navy/periwinkle/cream; Arbotek display + Poppins); this app's `globals.css` carries the semantic subset. NOTE: quote/gift still ship an older pink/teal palette — alignment is a separate decision |

## One flow: v2 (v1 sunset 2026-09-30)

Every host runs the four-step journey in `src/v2/` — Design → Card → Inside →
Deliver & pay. `src/lib/flow-version.ts` decides it, stamped by
`src/middleware.ts` as the `x-pg-flow` request header and on
`<body data-flow>`. It ran on builder2.pinatagrams.com first and replaced the
original flow (v1) on builder.pinatagrams.com on 2026-09-30; builder2 keeps
serving it.

| Host | Hub variant profile | Pricing |
|---|---|---|
| builder.pinatagrams.com | whichever profile lists the host (admin → Builder → Storefronts) | from that profile |
| builder2.pinatagrams.com | `version-b` | tiered + FedEx/USPS |

Prices and carriers come from each host's variant profile in the hub, and
checkout re-resolves them per host. v1's code (`src/app/design/design-flow.tsx`,
`/cart`'s cart view, the v1 home) is no longer served in production — `/cart`
redirects to `/design?step=deliver` — and stays only until it's removed.
Locally, `?flow=v1` still previews it (remembered in a cookie; `?flow=` resets),
and `?variant=<name>` previews a hub profile, e.g.
`http://localhost:3006/?variant=version-b`. Production ignores both overrides.

Server pieces added with the overhaul:

- Shopify Admin API version is pinned ONCE in `src/lib/shopify.ts` (2026-07).
- `GET /api/cron/expire-drafts` (daily, `CRON_SECRET`) deletes unpaid builder
  drafts whose delivery date can no longer be met — a **dry run** (logs what
  it would delete) until `DRAFT_EXPIRY_MODE=delete` is set.
- `POST /api/webhooks/orders-paid` sends `order_paid` to PostHog, joined to the
  shopper's session via the `_phDistinctId` / `_phSessionId` order attributes.
  The builder subscribes Shopify's `orders/paid` topic to it by itself
  (`src/lib/webhooks.ts`: once per instance after a production checkout, plus
  the daily `GET /api/cron/ensure-webhooks`), trimmed to non-personal fields.
  Needs `read_orders` on the Shopify app. The HMAC is checked against
  `SHOPIFY_CLIENT_SECRET` (or `SHOPIFY_WEBHOOK_SECRET` for a hand-made admin
  webhook); `GET` on the same path says whether the subscription exists (and
  creates it if missing, once per instance).
- Analytics (GA4, Meta pixel, OpenAI pixel, PostHog) only run in production on
  `*.pinatagrams.com`; PostHog loads lazily.
- OpenAI uses the same public pixel ID as Shopify's official ChatGPT app
  (`NEXT_PUBLIC_OPENAI_PIXEL_ID` overrides the default). The builder sends
  page views, add-to-cart and checkout-start events. At payment and resume,
  the SDK's consent-controlled `__oppref` cookie is carried into the Shopify
  invoice URL. Shopify's app owns the completed-purchase event; creating a
  draft or returning to the builder must never send another purchase.
  Test with `node --test tests/openai-ads.test.mjs`; verify live page/checkout
  events in OpenAI Ads Manager and a completed test purchase in Shopify.

## The staff embed: `/embed/design`

The label editor on a page of its own, for Paper
(paper.betterthanaletter.com) to show in a frame when staff make a one-off
sample — so samples are designed with the editor customers use, and a change
to the editor reaches them the moment it is deployed. The whole story and the
message contract are in `src/lib/embed.ts`; Paper keeps the other copy in
`paper-next: src/lib/builder-embed.ts`. Change both together.

- It is the journey's own "Make your own" view (`EditorView`), nothing else:
  no cart, no checkout, no site header or footer (`src/app/layout.tsx`), and
  no analytics — `analyticsEnabled()` is false on `/embed/*`, so staff never
  reach the funnel, the pixels or session replay.
- "Use this design" stages the print file and its `design.json` under
  `builder-art/` exactly as for an order, then tells the framing page where
  they are (URL + sha256). Paper downloads the file, checks the hash and
  keeps its own copy; the staged one is swept after 90 days like any other.
- Only Paper may frame it: `src/middleware.ts` sets
  `Content-Security-Policy: frame-ancestors https://paper.betterthanaletter.com`
  on `/embed/*` (plus `http://localhost:3000`, Paper's dev server, off
  production). No other page gets that header — framing of the rest of the
  site is unchanged.
- Opened directly (not in a frame) it still works, so it can be looked at;
  the design just isn't sent anywhere.
- `?style=` names the body whose box the "On the box" preview shows (hub id
  or name; unknown → the default).

### `/embed/sample` — the journey's step one, for starting a sample

Paper's "New sample" page frames this one. It is step one of the journey as
a shopper meets it — the Stage with its body chip and style arrows, "Pick
your design" with the occasion chips, the grid, search and the whole
library, and "Make your own" opening the editor — built from the journey's
own components (`Stage`, `StepDesign`, the sheets in `sheets.tsx`,
`EditorView`), so a change to step one is a change here. The wiring
(`src/app/embed/sample/embed-sample.tsx`) follows `DesignFlowV2`'s for that
step; a test fails if the page stops importing those components.

- Differences from the journey: every body style is offered, in stock or not
  (a sample can be of anything); nothing is priced; nothing is kept in the
  browser; no cart, checkout or analytics.
- The one button is "Use this piñata". It sends the framing page a `choice`
  message: the body (hub id, name, and the body as Paper names it —
  `embedBodyToken`, the same token checkout puts after `CUSTOM-` in a SKU),
  the front (a store design's print file on the store's CDN; a hub
  graphic's file and sha256; or a design made here, staged as for an order),
  and the card the message prints on. Paper checks every address and keeps
  its own copies.
- Same framing rule and the same `ready` / `init` / `close` messages as
  `/embed/design`.

Test with `node --test tests/embed.test.mjs`. To try it with Paper locally:
run this app on a port of your choice and start paper-next with
`BUILDER_EMBED_ORIGIN=http://localhost:<port>` (its dev server must be on
:3000). Note a browser does not run a framed page from another site while
its tab is in the background — test in a visible tab.

## Current state (B2C flow v1)

Full flow: body style (live availability from the hub) → graphic — "Pick a
graphic" (Shopify front-graphic library, `public/graphics.json` snapshot) or
"Design a graphic" (canvas: box-photo overlay, inline text editing, layers,
photo upload) → gift message → filling (Candy / School Fun Pack / Dog Treats /
Cat Treats / Realsy Dates) → delivery date ([src/lib/delivery.ts](src/lib/delivery.ts)
— placeholder rules, port the real pinatagrams.com blackout logic) → cart
(localStorage, qty steppers) → address → `/api/checkout`.

Checkout recomputes prices server-side from the hub and assembles the complete
`draftOrderCreate` input Paper needs (`_bodyStyle`, `_design`, `_frontGraphic`,
`_fillings`, `_requestedDate`, `message`). It runs as a DRY RUN (returns the
payload) until `SHOPIFY_SHOP` / `SHOPIFY_CLIENT_ID` / `SHOPIFY_CLIENT_SECRET`
are set — the admin.btal app with `write_draft_orders` scope. Custom-design
art upload to Blob is still a placeholder (`PENDING_RENDER_UPLOAD`).

## Milestones (from the roadmap)

1. ~~Hub public read API + this scaffold~~ ← done
2. Canvas editor (react-konva) + DesignDocument schema — **seeded** (versioned
   text-only v1 at `/design`; images/shapes/templates still to come)
3. Server-authoritative 300-DPI render (Konva on node-canvas Route Handler —
   verify Vercel native-addon support EARLY; this is the load-bearing risk)
4. Uploads (hardened: size cap, magic-byte sniff, no SVG, EXIF strip,
   Turnstile) → Vercel Blob
5. Draft-order checkout (server-side pricing, GraphQL variables, paid-gate
   lands in Paper in the SAME release) + saved designs (Neon)
6. betterthanaletter.com embed (iframe/postMessage)

## Dev

```
npm install
npm run dev        # http://localhost:3006
```

Needs the hub running for data: `cd ../admin && npm run dev` (port 3005), with
its `.env.local` pointing at the seeded Neon DB. `NEXT_PUBLIC_HUB_URL` in
`.env.local` selects the hub (defaults to production when unset).

## Deployed

**https://builder-pinatagrams.vercel.app** (Vercel project
`builder-pinatagrams`, CLI-deployed 2026-07-02). Prod uses the live hub
(`NEXT_PUBLIC_HUB_URL` unset → falls back to admin.betterthanaletter.com).
Still to do: GitHub repo + Vercel git integration (deploys are CLI-only for
now), DNS `builder.pinatagrams.com` CNAME, and the hub must serve
`/api/public/catalog` + `/price` (admin commit `5160452` — push pending).
