import { NextResponse } from "next/server";
import {
  HUB_URL,
  type HubAddon,
  type HubCatalog,
  type HubPrice,
} from "@/lib/hub";
import {
  addressKey,
  fillingAllowsAddon,
  formatAddress,
  resolveFillings,
  type CartLine,
  type DeliveryAddress,
} from "@/lib/flow";
import {
  deliveryProblemAtCheckout,
  resolveDeliveryConfig,
} from "@/lib/delivery";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Draft-order checkout. The client sends a SELECTION (cart lines + payer
 * email), never a price — everything money-related is recomputed here from
 * the hub, and every line is re-validated against the live catalog (style
 * must exist and be in stock). Addresses attach PER LINE; lines are grouped
 * by address and each group becomes its own draft order + invoice
 * (fulfillment: one order = one ship-to = one ShipStation label).
 *
 * Partial failure: created orders are returned in `createdSoFar` with their
 * address group keys so the client can mark those lines ordered and retry
 * only the remainder — no duplicate orders.
 *
 * Modes: with SHOPIFY_SHOP + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET it
 * creates real draft orders AND sends each invoice email; otherwise dry-run.
 * The raw draft-order payload is only included outside production.
 */

const MAX_LINES = 20;
const MAX_QTY = 25; // B2C sanity bound; bulk goes through quote/corporate
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * The generic "Custom Built Piñatagram" product: one variant per body style,
 * SKU CUSTOM-{BODY}. Paper derives the body style from that SKU exactly like
 * legacy orders (spaces not hyphens — its parser splits on the LAST hyphen),
 * Shopify reporting sees a real product, and the invoice shows its image.
 * A style whose variant doesn't resolve refuses checkout loudly — a custom
 * line item without a SKU would strand the order for Paper.
 */
const CUSTOM_PRODUCT_GID = "gid://shopify/Product/7741496623202";
const SKU_SUFFIX_SPECIAL: Record<string, string> = {
  "white-uni": "WHITE UNICORN",
  "pink-uni": "PINK UNICORN",
};
const customSkuFor = (styleId: string) =>
  `CUSTOM-${SKU_SUFFIX_SPECIAL[styleId] ?? styleId.toUpperCase().replace(/-/g, " ")}`;

// Variant ids by SKU, cached for the life of the serverless instance
// (10-minute TTL); an empty map makes the fail-fast check below refuse.
let variantCache: { at: number; bySku: Map<string, string> } | null = null;

async function customVariantsBySku(
  gqlUrl: string,
  headers: Record<string, string>,
): Promise<Map<string, string>> {
  if (variantCache && Date.now() - variantCache.at < 10 * 60_000) {
    return variantCache.bySku;
  }
  try {
    const res = await fetch(gqlUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        query: `query($id: ID!) {
          product(id: $id) { variants(first: 50) { nodes { id sku } } }
        }`,
        variables: { id: CUSTOM_PRODUCT_GID },
      }),
    });
    const gql = await res.json();
    const nodes: { id: string; sku: string | null }[] =
      gql?.data?.product?.variants?.nodes ?? [];
    const bySku = new Map<string, string>();
    for (const n of nodes) if (n.sku) bySku.set(n.sku, n.id);
    variantCache = { at: Date.now(), bySku };
    return bySku;
  } catch {
    return new Map();
  }
}
// Add-on variant ids by SKU (e.g. DOUBLE-FILLING → the real Double Candy
// product). Every active add-on MUST resolve to a live variant — checkout
// refuses orders whose add-on doesn't, rather than degrading into a second
// order shape. A refusal is either transient (retry works) or a config
// error to fix in Shopify admin. Cached per SKU for 10 minutes.
const addonVariantCache = new Map<string, { at: number; id: string | null }>();

async function addonVariantIds(
  gqlUrl: string,
  headers: Record<string, string>,
  skus: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const sku of skus) {
    const hit = addonVariantCache.get(sku);
    if (hit && Date.now() - hit.at < 10 * 60_000) {
      if (hit.id) out.set(sku, hit.id);
      continue;
    }
    try {
      const res = await fetch(gqlUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: `query($q: String!) {
            productVariants(first: 5, query: $q) { nodes { id sku } }
          }`,
          variables: { q: `sku:${JSON.stringify(sku)}` },
        }),
      });
      const gql = await res.json();
      const nodes: { id: string; sku: string | null }[] =
        gql?.data?.productVariants?.nodes ?? [];
      // The query is a search; only trust an exact SKU match.
      const exact = nodes.find((n) => n.sku === sku);
      addonVariantCache.set(sku, { at: Date.now(), id: exact?.id ?? null });
      if (exact) out.set(sku, exact.id);
    } catch {
      // Nothing cached on a fetch error → the caller refuses this order
      // and the very next request retries the lookup.
    }
  }
  return out;
}

const ART_RE = /^https:\/\/cdn\.shopify\.com\//;
// The builder's OWN Blob store, exact host — a tampered client can't point
// _frontGraphic at some other Vercel customer's blob, and Paper allowlists
// this same hostname (full equality) before snapshotting art at ingest.
const BLOB_RE =
  /^https:\/\/yrfds6n4iwscziqm\.public\.blob\.vercel-storage\.com\//;
const DESIGN_RE = /^[A-Z0-9]{2,24}$/;
// Lowercase hex sha256 of the uploaded print bytes, computed by the editor
// at save time. Required for blob-hosted art: Paper re-hashes the blob it
// downloads and refuses a mismatch, so the bytes staged in the transient
// store can't change between save and snapshot.
const SHA256_RE = /^[a-f0-9]{64}$/;

type CheckoutBody = { lines: CartLine[]; email?: string };

function bad(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max).trim() : "";
}

function cleanAddress(a: unknown): DeliveryAddress | null {
  if (!a || typeof a !== "object") return null;
  const o = a as Record<string, unknown>;
  const out: DeliveryAddress = {
    name: str(o.name, 80),
    address1: str(o.address1, 120),
    address2: str(o.address2, 120),
    city: str(o.city, 60),
    province: str(o.province, 40),
    zip: str(o.zip, 16),
    phone: str(o.phone, 24),
  };
  if (!out.name || !out.address1 || !out.city || !out.province || !out.zip)
    return null;
  return out;
}

export async function POST(req: Request) {
  // Draft orders write into Shopify — keep bots from spamming them.
  if (!rateLimit(`checkout:${clientIp(req)}`, 6, 60_000)) {
    return NextResponse.json(
      { error: "Too many checkout attempts — give it a minute and try again." },
      { status: 429 },
    );
  }

  let body: CheckoutBody;
  try {
    body = await req.json();
  } catch {
    return bad("Malformed JSON.");
  }

  // Email is OPTIONAL: consumers go straight to Shopify's payment page,
  // which collects contact info itself. When present (older clients, future
  // corporate flows) it goes on the draft and the invoice email still sends.
  const email = str(body?.email, 120);
  if (email && !EMAIL_RE.test(email)) return bad("That email doesn't look right.");
  const rawLines = body?.lines;
  if (!Array.isArray(rawLines) || rawLines.length === 0)
    return bad("Cart is empty.");
  if (rawLines.length > MAX_LINES)
    return bad(`That's a lot of piñatas — the builder caps at ${MAX_LINES} lines. For bulk orders use the quote form.`);

  // Live catalog: styles must exist and be in stock at order time.
  const catalogRes = await fetch(`${HUB_URL}/api/public/catalog`, {
    next: { revalidate: 60 },
  });
  if (!catalogRes.ok) {
    return NextResponse.json(
      { error: "The catalog is unavailable right now — try again shortly." },
      { status: 503 },
    );
  }
  const catalog: HubCatalog = await catalogRes.json();
  const styleById = new Map(catalog.bodyStyles.map((s) => [s.id, s]));
  const deliveryCfg = resolveDeliveryConfig(catalog.delivery);
  // Add-ons re-resolve from the live catalog: the client sends ids only,
  // labels + prices come from the hub at order time.
  const addonById = new Map((catalog.addons ?? []).map((a) => [a.id, a]));
  // Fillings too: label → record (price delta + allowed-add-ons rule).
  const fillingByLabel = new Map(
    resolveFillings(catalog.fillings).map((f) => [f.label, f]),
  );

  type CleanLine = {
    title: string;
    qty: number;
    styleId: string;
    styleName: string;
    design: string;
    frontGraphic: string;
    frontGraphicSha256: string;
    designJson: string;
    filling: string;
    fillingCents: number;
    addons: HubAddon[];
    deliveryDate: string;
    message: string;
    address: DeliveryAddress;
  };
  const lines: CleanLine[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const l = rawLines[i];
    const label = `Piñata ${i + 1}`;
    const style = typeof l?.styleId === "string" ? styleById.get(l.styleId) : undefined;
    if (!style) return bad(`${label}: that body style no longer exists — remove it and pick another.`);
    if (!style.inStock)
      return bad(`${label}: the ${style.name} body is out of stock right now — swap its style and try again.`);
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > MAX_QTY)
      return bad(`${label}: quantity must be between 1 and ${MAX_QTY}.`);
    const fillingRec = fillingByLabel.get(String(l.filling ?? ""));
    if (!fillingRec)
      return bad(`${label}: pick a filling.`);
    const addonIds = Array.isArray(l.addons) ? [...new Set(l.addons)] : [];
    const addons = addonIds.map((id) => addonById.get(String(id)));
    if (addons.some((a) => !a))
      return bad(
        `${label}: one of its add-ons is no longer available — edit the piñata and re-pick.`,
      );
    // The filling's rule, enforced server-side: a stale client can't sneak
    // an add-on into a filling that doesn't allow it (e.g. Realsy Dates).
    const blocked = addons.find((a) => !fillingAllowsAddon(fillingRec, a!.id));
    if (blocked)
      return bad(
        `${label}: ${blocked!.label} isn't available with ${fillingRec.label} — edit the piñata and try again.`,
      );
    const dateIssue = deliveryProblemAtCheckout(
      String(l.deliveryDate ?? ""),
      deliveryCfg,
    );
    if (dateIssue) return bad(`${label}: ${dateIssue}`);
    const message = str(l.message, 300);
    const address = cleanAddress(l.address);
    if (!address) return bad(`${label}: its delivery address is incomplete.`);

    let design: string;
    let frontGraphic: string;
    let frontGraphicSha256 = "";
    let designJson = "";
    let title: string;
    if (l.graphic?.type === "shopify") {
      design = str(l.graphic.design, 24).toUpperCase();
      if (!DESIGN_RE.test(design)) return bad(`${label}: unrecognized graphic.`);
      const art = str(l.graphic.art, 500);
      if (!ART_RE.test(art)) return bad(`${label}: unrecognized graphic art.`);
      frontGraphic = art;
      title = `${str(l.graphic.title, 120) || design} — ${style.name}`;
    } else if (l.graphic?.type === "custom") {
      design = "custom";
      // The flattened print file the editor uploaded to Blob; Paper prints
      // from this URL. No placeholder path: an order with unprintable art
      // is refused HERE, not discovered at print time.
      const art = str(l.graphic.art, 500);
      if (!BLOB_RE.test(art))
        return bad(
          `${label}: your design hasn't finished saving — give it a few seconds and try again (or open the design and press Looks good once more).`,
        );
      frontGraphic = art;
      // Blob art without its save-time hash can't be integrity-checked by
      // Paper, so it can't be sold. Only carts saved before the hash
      // existed hit this; a re-save re-uploads and stamps it.
      const sha = str(l.graphic.artSha256, 64).toLowerCase();
      if (!SHA256_RE.test(sha))
        return bad(
          `${label}: this design was saved before a recent update — open it, press Looks good once more, and try again.`,
        );
      frontGraphicSha256 = sha;
      const sidecar = str(l.graphic.designUrl, 500);
      designJson = BLOB_RE.test(sidecar) ? sidecar : "";
      title = `Custom Piñatagram — ${style.name}`;
    } else {
      return bad(`${label}: pick or design a graphic.`);
    }

    lines.push({
      title,
      qty: l.qty,
      styleId: style.id,
      styleName: style.name,
      design,
      frontGraphic,
      frontGraphicSha256,
      designJson,
      filling: fillingRec.label,
      fillingCents: fillingRec.priceCents,
      addons: addons as HubAddon[],
      deliveryDate: l.deliveryDate,
      message,
      address,
    });
  }

  // Server-side price: single-destination B2C — per-unit product + shipping.
  const priceRes = await fetch(
    `${HUB_URL}/api/public/price?qty=1&fill=filled&bodyType=standard&graphicType=custom&mode=individual&carrier=standard`,
    { next: { revalidate: 300 } },
  );
  if (!priceRes.ok) {
    return NextResponse.json(
      { error: "Pricing is unavailable right now — try again shortly." },
      { status: 503 },
    );
  }
  const price: HubPrice = await priceRes.json();
  // Never sell at zero — a misconfigured pricing table must fail loudly.
  if (!Number.isFinite(price.unitPriceCents) || price.unitPriceCents <= 0) {
    return NextResponse.json(
      { error: "Pricing is unavailable right now — try again shortly." },
      { status: 503 },
    );
  }
  // ONE order shape, exactly like legacy storefront orders: piñata lines at
  // retail (+ the filling's price delta — a filling is what the piñata IS,
  // so it prices into the line), each add-on as its own aggregated product
  // line (money + sales reporting), while WHICH piñata gets it stays on
  // that piñata line's _addons attribute (the packer's mapping).
  const lineUnit = (l: CleanLine) =>
    ((price.unitPriceCents + l.fillingCents) / 100).toFixed(2);
  const addonTotals = (groupLines: CleanLine[]) => {
    const units = new Map<string, { addon: HubAddon; qty: number }>();
    for (const l of groupLines)
      for (const a of l.addons)
        units.set(a.id, { addon: a, qty: (units.get(a.id)?.qty ?? 0) + l.qty });
    return [...units.values()];
  };

  // One draft order per delivery address (ShipStation: one order = one label).
  const groups = new Map<string, CleanLine[]>();
  for (const l of lines) {
    const key = addressKey(l.address);
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }

  const lineAttributes = (l: CleanLine) => [
    // No leading underscore = SHOWS on the payment page under the line
    // title — the customer sees their choices while paying. (The line title
    // is the generic product's, so the graphic is named here.)
    {
      key: "Graphic",
      value: l.design === "custom" ? "Your custom design" : l.title,
    },
    { key: "Body style", value: l.styleName },
    { key: "Filling", value: l.filling },
    ...(l.addons.length
      ? [{ key: "Add-ons", value: l.addons.map((a) => a.label).join(", ") }]
      : []),
    { key: "Arrives by", value: l.deliveryDate },
    // Underscored = hidden machine rails Paper reads at fulfillment.
    { key: "_bodyStyle", value: l.styleId },
    { key: "_design", value: l.design },
    { key: "_frontGraphic", value: l.frontGraphic },
    // Only blob-hosted custom art carries a hash; library picks are
    // first-party cdn.shopify.com files Paper snapshots without one.
    ...(l.frontGraphicSha256
      ? [{ key: "_frontGraphicSha256", value: l.frontGraphicSha256 }]
      : []),
    ...(l.designJson ? [{ key: "_designJson", value: l.designJson }] : []),
    { key: "_fillings", value: l.filling },
    // Comma-separated labels — exactly how Paper splits _addons. This stays
    // on the piñata line even when the add-on charges as its own product
    // line: it's the per-piñata mapping the packer works from.
    ...(l.addons.length
      ? [{ key: "_addons", value: l.addons.map((a) => a.label).join(", ") }]
      : []),
    { key: "_requestedDate", value: l.deliveryDate },
    ...(l.message ? [{ key: "message", value: l.message }] : []),
  ];

  // Dry-run payload only (no Shopify creds to resolve variants): plain
  // custom line items mirroring the real structure — piñata at retail plus
  // one line per add-on.
  const customLine = (l: CleanLine) => ({
    title: l.title,
    originalUnitPrice: lineUnit(l),
    quantity: l.qty,
    requiresShipping: true,
    customAttributes: lineAttributes(l),
  });

  const draftOrders = [...groups.entries()].map(([groupKey, groupLines]) => {
    const a = groupLines[0].address;
    const units = groupLines.reduce((s, l) => s + l.qty, 0);
    const [firstName, ...rest] = a.name.split(/\s+/);
    const lastName = rest.join(" ") || firstName;
    return {
      groupKey,
      shipTo: formatAddress(a),
      lines: groupLines,
      input: {
        ...(email ? { email } : {}),
        tags: ["builder"],
        note: "builder.pinatagrams.com",
        shippingAddress: {
          firstName,
          lastName,
          address1: a.address1,
          address2: a.address2 || null,
          city: a.city,
          province: a.province,
          zip: a.zip,
          countryCode: "US",
          phone: a.phone || null,
        },
        shippingLine: {
          title: "FedEx 2-Day delivery",
          price: ((price.shipPerUnitCents * units) / 100).toFixed(2),
        },
        lineItems: [
          ...groupLines.map((l) => customLine(l)),
          ...addonTotals(groupLines).map(({ addon, qty }) => ({
            title: addon.label,
            originalUnitPrice: (addon.priceCents / 100).toFixed(2),
            quantity: qty,
            requiresShipping: true,
          })),
        ] as unknown[],
      },
    };
  });

  const shop = process.env.SHOPIFY_SHOP;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    const isProd = process.env.VERCEL_ENV === "production";
    return NextResponse.json({
      dryRun: true,
      reason: isProd
        ? "Checkout isn't taking live orders quite yet — your cart is saved and nothing was charged."
        : "Shopify credentials aren't configured (needs SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET). This is exactly what would be sent:",
      // The raw payload is a debugging tool, not customer content.
      draftOrders: isProd
        ? draftOrders.map(({ groupKey, shipTo }) => ({ groupKey, shipTo }))
        : draftOrders,
    });
  }

  // Mint a short-lived Admin token (client-credentials grant).
  const tokenRes = await fetch(
    `https://${shop}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    },
  );
  if (!tokenRes.ok) {
    return NextResponse.json(
      { error: "Could not authenticate with Shopify." },
      { status: 502 },
    );
  }
  const { access_token } = await tokenRes.json();

  const gqlHeaders = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": access_token,
  };
  const gqlUrl = `https://${shop}.myshopify.com/admin/api/2025-01/graphql.json`;

  // Attach each line to the generic Custom Built Piñatagram variant for its
  // body style (real SKU → Paper parses the body like any legacy order; the
  // product image shows on the invoice). priceOverride keeps the hub's
  // price authoritative.
  const variantBySku = await customVariantsBySku(gqlUrl, gqlHeaders);
  const addonSkus = [
    ...new Set(
      lines.flatMap((l) =>
        l.addons.map((a) => a.sku).filter((s): s is string => !!s),
      ),
    ),
  ];
  const addonVariants = await addonVariantIds(gqlUrl, gqlHeaders, addonSkus);

  // Fail-fast BEFORE creating anything: every piñata must attach to its
  // CUSTOM-{BODY} variant and every add-on to its own product's variant.
  // A miss is a config error (deleted variant, SKU typo) or an API flake —
  // refuse loudly either way; a silent fallback shape would strand orders
  // Paper can't parse (no SKU → no body style) and rot sales reporting.
  for (const l of lines) {
    if (!variantBySku.has(customSkuFor(l.styleId))) {
      console.error(`checkout: no variant for ${customSkuFor(l.styleId)}`);
      return NextResponse.json(
        {
          error: `Checkout is temporarily unavailable for the ${l.styleName} body — try again in a minute.`,
        },
        { status: 502 },
      );
    }
    const dead = l.addons.find((a) => !a.sku || !addonVariants.has(a.sku));
    if (dead) {
      console.error(
        `checkout: add-on "${dead.label}" (sku ${dead.sku ?? "none"}) has no Shopify variant`,
      );
      return NextResponse.json(
        {
          error: `"${dead.label}" can't be added right now — remove it from your piñata and try again.`,
        },
        { status: 502 },
      );
    }
  }

  for (const order of draftOrders) {
    order.input.lineItems = [
      ...order.lines.map((l) => ({
        variantId: variantBySku.get(customSkuFor(l.styleId))!,
        quantity: l.qty,
        priceOverride: { amount: lineUnit(l), currencyCode: "USD" },
        customAttributes: lineAttributes(l),
      })),
      ...addonTotals(order.lines).map(({ addon, qty }) => ({
        variantId: addonVariants.get(addon.sku!)!,
        quantity: qty,
        // Hub price stays authoritative even if the product's price drifts.
        priceOverride: {
          amount: (addon.priceCents / 100).toFixed(2),
          currencyCode: "USD",
        },
      })),
    ];
  }

  const created: {
    groupKey: string;
    shipTo: string;
    invoiceUrl: string;
    draftOrderId: string;
    invoiceSent: boolean;
  }[] = [];

  for (const order of draftOrders) {
    const gqlRes = await fetch(gqlUrl, {
      method: "POST",
      headers: gqlHeaders,
      body: JSON.stringify({
        query: `mutation($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder { id invoiceUrl }
            userErrors { field message }
          }
        }`,
        variables: { input: order.input },
      }),
    });
    const gql = await gqlRes.json();
    const errs = gql?.data?.draftOrderCreate?.userErrors;
    if (!gqlRes.ok || gql.errors || (errs && errs.length)) {
      // Full response to the function log (only ops sees that); the client
      // gets Shopify's own error strings — field validation text, no secrets.
      console.error("draftOrderCreate failed", JSON.stringify(gql));
      const detail = [
        ...(Array.isArray(gql?.errors)
          ? gql.errors.map((e: { message?: string }) => e?.message)
          : []),
        ...(Array.isArray(errs)
          ? errs.map(
              (e: { field?: string[]; message?: string }) =>
                `${e?.field?.join(".") ?? ""}: ${e?.message ?? ""}`,
            )
          : []),
      ].filter(Boolean);
      // Scope trouble is the #1 setup failure: report what the minted token
      // actually carries (scope handles are config, not secrets).
      if (detail.some((d) => String(d).includes("Access denied"))) {
        try {
          const scopesRes = await fetch(
            `https://${shop}.myshopify.com/admin/oauth/access_scopes.json`,
            { headers: { "X-Shopify-Access-Token": access_token } },
          );
          const scopes = await scopesRes.json();
          detail.push(
            `token scopes: ${
              (scopes?.access_scopes ?? [])
                .map((s: { handle: string }) => s.handle)
                .join(", ") || "(none)"
            }`,
          );
        } catch {}
      }
      return NextResponse.json(
        {
          error: `Shopify rejected the order for ${order.shipTo}. Any orders listed below WERE created — don't re-order those.`,
          detail,
          createdSoFar: created,
        },
        { status: 502 },
      );
    }
    const draft = gql.data.draftOrderCreate.draftOrder;

    // Invoice email only when we have an address to send it to — the
    // consumer flow skips email entirely and pays via redirect instead.
    let invoiceSent = false;
    if (!email) {
      created.push({
        groupKey: order.groupKey,
        shipTo: order.shipTo,
        draftOrderId: draft.id,
        invoiceUrl: draft.invoiceUrl,
        invoiceSent,
      });
      continue;
    }
    try {
      const sendRes = await fetch(gqlUrl, {
        method: "POST",
        headers: gqlHeaders,
        body: JSON.stringify({
          query: `mutation($id: ID!) {
            draftOrderInvoiceSend(id: $id) {
              draftOrder { id }
              userErrors { field message }
            }
          }`,
          variables: { id: draft.id },
        }),
      });
      const sendGql = await sendRes.json();
      invoiceSent =
        sendRes.ok &&
        !sendGql.errors &&
        !(sendGql?.data?.draftOrderInvoiceSend?.userErrors?.length > 0);
    } catch {
      invoiceSent = false;
    }

    created.push({
      groupKey: order.groupKey,
      shipTo: order.shipTo,
      draftOrderId: draft.id,
      invoiceUrl: draft.invoiceUrl,
      invoiceSent,
    });
  }

  return NextResponse.json({ dryRun: false, orders: created });
}
