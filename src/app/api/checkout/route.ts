import { NextResponse } from "next/server";
import { HUB_URL, type HubPrice } from "@/lib/hub";
import { FILLINGS, type CartLine, type ShippingAddress } from "@/lib/flow";
import { deliveryProblem } from "@/lib/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Draft-order checkout. The client sends a SELECTION (cart lines + address),
 * never a price — everything money-related is recomputed here from the hub's
 * public plane. The assembled draftOrderCreate input carries every line-item
 * property Paper's ingestion reads: _fillings, message, _requestedDate, plus
 * _bodyStyle/_design for print resolution.
 *
 * Modes:
 *  - Shopify env creds present (SHOPIFY_SHOP, SHOPIFY_CLIENT_ID,
 *    SHOPIFY_CLIENT_SECRET — the admin.btal dev-dashboard app with
 *    write_draft_orders) → real draftOrderCreate, returns the invoice URL.
 *  - Otherwise → dry run: returns the exact input we WOULD send.
 *
 * TODO before real orders flow: custom designs need their flattened art
 * uploaded to Vercel Blob so _frontGraphic is a durable https URL (today the
 * attribute is a placeholder), and Paper needs the _frontGraphic read-rail +
 * financial_status paid-gate release.
 */

const MAX_LINES = 20;
const MAX_QTY = 25; // B2C sanity bound; bulk goes through quote/corporate

type CheckoutBody = { lines: CartLine[]; address: ShippingAddress };

function bad(error: string): NextResponse {
  return NextResponse.json({ error }, { status: 400 });
}

export async function POST(req: Request) {
  let body: CheckoutBody;
  try {
    body = await req.json();
  } catch {
    return bad("Malformed JSON.");
  }

  const { lines, address } = body;
  if (!Array.isArray(lines) || lines.length === 0) return bad("Cart is empty.");
  if (lines.length > MAX_LINES) return bad("Too many cart lines.");
  for (const l of lines) {
    if (!l?.styleId || typeof l.styleId !== "string") return bad("Bad line: style.");
    if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > MAX_QTY)
      return bad(`Bad line: qty must be 1..${MAX_QTY}.`);
    if (!(FILLINGS as readonly string[]).includes(l.filling))
      return bad("Bad line: filling.");
    const dateIssue = deliveryProblem(l.deliveryDate);
    if (dateIssue) return bad(`Bad line: ${dateIssue}`);
    if (l.graphic?.type !== "shopify" && l.graphic?.type !== "custom")
      return bad("Bad line: graphic.");
    if (typeof l.message !== "string" || l.message.length > 300)
      return bad("Bad line: message.");
  }
  if (!address?.name || !address.email?.includes("@") || !address.address1 ||
      !address.city || !address.province || !address.zip) {
    return bad("Incomplete delivery address.");
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
  const totalUnits = lines.reduce((s, l) => s + l.qty, 0);
  const unitPrice = (price.unitPriceCents / 100).toFixed(2);
  const shippingTotal = ((price.shipPerUnitCents * totalUnits) / 100).toFixed(2);

  const [firstName, ...rest] = address.name.trim().split(/\s+/);
  const lastName = rest.join(" ") || firstName;

  const draftOrderInput = {
    email: address.email,
    tags: ["builder"],
    note: "builder.pinatagrams.com",
    shippingAddress: {
      firstName,
      lastName,
      address1: address.address1,
      address2: address.address2 || null,
      city: address.city,
      province: address.province,
      zip: address.zip,
      countryCode: "US",
      phone: address.phone || null,
    },
    shippingLine: { title: "Standard delivery", price: shippingTotal },
    lineItems: lines.map((l) => ({
      title:
        l.graphic.type === "custom"
          ? `Custom Piñatagram — ${l.styleName}`
          : `${l.graphic.title} — ${l.styleName}`,
      originalUnitPrice: unitPrice,
      quantity: l.qty,
      requiresShipping: true,
      customAttributes: [
        { key: "_bodyStyle", value: l.styleId },
        {
          key: "_design",
          value: l.graphic.type === "custom" ? "custom" : l.graphic.design,
        },
        {
          key: "_frontGraphic",
          value:
            l.graphic.type === "shopify"
              ? (l.graphic.art ?? "")
              : "PENDING_RENDER_UPLOAD", // TODO: Blob URL of the flattened art
        },
        { key: "_fillings", value: l.filling },
        { key: "_requestedDate", value: l.deliveryDate },
        ...(l.message ? [{ key: "message", value: l.message }] : []),
      ].filter((a) => a.value !== ""),
    })),
  };

  const shop = process.env.SHOPIFY_SHOP;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    return NextResponse.json({
      dryRun: true,
      reason:
        "Shopify credentials aren't configured on this deployment yet (needs SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET from the admin.btal app with the write_draft_orders scope). This is exactly what would be sent:",
      draftOrderInput,
    });
  }

  // Mint a short-lived Admin token (client-credentials grant — same flow the
  // hub proved for webhook registration).
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

  const gqlRes = await fetch(
    `https://${shop}.myshopify.com/admin/api/2025-01/graphql.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": access_token,
      },
      body: JSON.stringify({
        query: `mutation($input: DraftOrderInput!) {
          draftOrderCreate(input: $input) {
            draftOrder { id invoiceUrl }
            userErrors { field message }
          }
        }`,
        variables: { input: draftOrderInput },
      }),
    },
  );
  const gql = await gqlRes.json();
  const errs = gql?.data?.draftOrderCreate?.userErrors;
  if (!gqlRes.ok || gql.errors || (errs && errs.length)) {
    return NextResponse.json(
      { error: "Shopify rejected the order.", details: gql.errors ?? errs },
      { status: 502 },
    );
  }
  const draft = gql.data.draftOrderCreate.draftOrder;
  return NextResponse.json({
    dryRun: false,
    draftOrderId: draft.id,
    invoiceUrl: draft.invoiceUrl,
  });
}
