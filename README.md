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
