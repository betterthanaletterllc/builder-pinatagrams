import { NextResponse } from "next/server";
import { HUB_URL, type HubCatalog, type HubPrice } from "@/lib/hub";
import {
  addressKey,
  FILLINGS,
  formatAddress,
  type CartLine,
  type DeliveryAddress,
} from "@/lib/flow";
import {
  deliveryProblemAtCheckout,
  resolveDeliveryConfig,
} from "@/lib/delivery";

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
 * Lines fall back to plain custom line items if a style has no variant yet.
 */
const CUSTOM_PRODUCT_GID = "gid://shopify/Product/7741496623202";
const SKU_SUFFIX_SPECIAL: Record<string, string> = {
  "white-uni": "WHITE UNICORN",
  "pink-uni": "PINK UNICORN",
};
const customSkuFor = (styleId: string) =>
  `CUSTOM-${SKU_SUFFIX_SPECIAL[styleId] ?? styleId.toUpperCase().replace(/-/g, " ")}`;

// Variant ids by SKU, cached for the life of the serverless instance
// (10-minute TTL); an empty map just means every line takes the fallback.
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
const ART_RE = /^https:\/\/cdn\.shopify\.com\//;
const BLOB_RE = /^https:\/\/[a-z0-9]+\.public\.blob\.vercel-storage\.com\//;
const DESIGN_RE = /^[A-Z0-9]{2,24}$/;

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

  type CleanLine = {
    title: string;
    qty: number;
    styleId: string;
    styleName: string;
    design: string;
    frontGraphic: string;
    designJson: string;
    filling: string;
    addonLabels: string[];
    addonCents: number;
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
    if (!(FILLINGS as readonly string[]).includes(l.filling))
      return bad(`${label}: pick a filling.`);
    const addonIds = Array.isArray(l.addons) ? [...new Set(l.addons)] : [];
    const addons = addonIds.map((id) => addonById.get(String(id)));
    if (addons.some((a) => !a))
      return bad(
        `${label}: one of its add-ons is no longer available — edit the piñata and re-pick.`,
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
      // The flattened print PNG the editor uploaded to Blob; Paper prints
      // from this URL. Placeholder only if the upload failed.
      const art = str(l.graphic.art, 500);
      frontGraphic = BLOB_RE.test(art) ? art : "PENDING_RENDER_UPLOAD";
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
      designJson,
      filling: l.filling,
      addonLabels: addons.map((a) => a!.label),
      addonCents: addons.reduce((s, a) => s + a!.priceCents, 0),
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
  // Add-ons ride on the line's unit price (no separate Shopify line item —
  // one line = one piñata as fulfillment sees it).
  const lineUnitPrice = (l: CleanLine) =>
    ((price.unitPriceCents + l.addonCents) / 100).toFixed(2);

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
    ...(l.addonLabels.length
      ? [{ key: "Add-ons", value: l.addonLabels.join(", ") }]
      : []),
    { key: "Arrives by", value: l.deliveryDate },
    // Underscored = hidden machine rails Paper reads at fulfillment.
    { key: "_bodyStyle", value: l.styleId },
    { key: "_design", value: l.design },
    { key: "_frontGraphic", value: l.frontGraphic },
    ...(l.designJson ? [{ key: "_designJson", value: l.designJson }] : []),
    { key: "_fillings", value: l.filling },
    // Comma-separated labels — exactly how Paper splits _addons.
    ...(l.addonLabels.length
      ? [{ key: "_addons", value: l.addonLabels.join(", ") }]
      : []),
    { key: "_requestedDate", value: l.deliveryDate },
    ...(l.message ? [{ key: "message", value: l.message }] : []),
  ];

  // Fallback shape (also the dry-run payload): a plain custom line item.
  const customLine = (l: CleanLine) => ({
    title:
      l.title + (l.addonLabels.length ? ` + ${l.addonLabels.join(" + ")}` : ""),
    originalUnitPrice: lineUnitPrice(l),
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
        lineItems: groupLines.map(customLine) as unknown[],
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
  // price authoritative. Missing variant → the custom-line fallback stands.
  const variantBySku = await customVariantsBySku(gqlUrl, gqlHeaders);
  for (const order of draftOrders) {
    order.input.lineItems = order.lines.map((l) => {
      const variantId = variantBySku.get(customSkuFor(l.styleId));
      return variantId
        ? {
            variantId,
            quantity: l.qty,
            priceOverride: {
              amount: lineUnitPrice(l),
              currencyCode: "USD",
            },
            customAttributes: lineAttributes(l),
          }
        : customLine(l);
    });
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
