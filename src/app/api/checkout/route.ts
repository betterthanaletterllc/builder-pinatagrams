import { NextResponse } from "next/server";
import { HUB_URL, type HubPrice } from "@/lib/hub";
import {
  addressComplete,
  addressKey,
  FILLINGS,
  formatAddress,
  type CartLine,
} from "@/lib/flow";
import { deliveryProblem } from "@/lib/delivery";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Draft-order checkout. The client sends a SELECTION (cart lines + payer
 * email), never a price — money is recomputed here from the hub's public
 * plane. Addresses attach PER LINE; fulfillment (ShipStation) is one order =
 * one ship-to = one label, so lines are GROUPED BY ADDRESS and each group
 * becomes its own draft order + invoice. Single-destination carts get exactly
 * one. (One payment across N orders = the roadmap's phase-2 Stripe work.)
 *
 * Line-item properties carry everything Paper's ingestion reads: _fillings,
 * message, _requestedDate, plus _bodyStyle/_design for print resolution.
 *
 * Modes: with SHOPIFY_SHOP + SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET (the
 * admin.btal app with write_draft_orders) it creates real draft orders;
 * otherwise it returns the exact inputs it WOULD send (dry run).
 *
 * TODO before real orders: custom designs need their flattened art on Blob
 * (today _frontGraphic is a placeholder) and Paper needs the _frontGraphic
 * read-rail + financial_status paid-gate release.
 */

const MAX_LINES = 20;
const MAX_QTY = 25; // B2C sanity bound; bulk goes through quote/corporate

type CheckoutBody = { lines: CartLine[]; email: string };

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

  const { lines, email } = body;
  if (!email?.includes("@")) return bad("A valid email is required.");
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
    if (!addressComplete(l.address))
      return bad("Bad line: missing delivery address.");
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
  const unitPrice = (price.unitPriceCents / 100).toFixed(2);

  // One draft order per delivery address (ShipStation: one order = one label).
  const groups = new Map<string, CartLine[]>();
  for (const l of lines) {
    const key = addressKey(l.address);
    groups.set(key, [...(groups.get(key) ?? []), l]);
  }

  const draftOrders = [...groups.values()].map((groupLines) => {
    const a = groupLines[0].address;
    const units = groupLines.reduce((s, l) => s + l.qty, 0);
    const [firstName, ...rest] = a.name.trim().split(/\s+/);
    const lastName = rest.join(" ") || firstName;
    return {
      shipTo: formatAddress(a),
      input: {
        email,
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
          title: "Standard delivery",
          price: ((price.shipPerUnitCents * units) / 100).toFixed(2),
        },
        lineItems: groupLines.map((l) => ({
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
                  : "PENDING_RENDER_UPLOAD", // TODO: Blob URL of flattened art
            },
            { key: "_fillings", value: l.filling },
            { key: "_requestedDate", value: l.deliveryDate },
            ...(l.message ? [{ key: "message", value: l.message }] : []),
          ].filter((attr) => attr.value !== ""),
        })),
      },
    };
  });

  const shop = process.env.SHOPIFY_SHOP;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;

  if (!shop || !clientId || !clientSecret) {
    return NextResponse.json({
      dryRun: true,
      reason:
        "Shopify credentials aren't configured on this deployment yet (needs SHOPIFY_SHOP, SHOPIFY_CLIENT_ID, SHOPIFY_CLIENT_SECRET from the admin.btal app with the write_draft_orders scope). This is exactly what would be sent:",
      draftOrders,
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

  const created: { shipTo: string; invoiceUrl: string; draftOrderId: string }[] =
    [];
  for (const order of draftOrders) {
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
          variables: { input: order.input },
        }),
      },
    );
    const gql = await gqlRes.json();
    const errs = gql?.data?.draftOrderCreate?.userErrors;
    if (!gqlRes.ok || gql.errors || (errs && errs.length)) {
      return NextResponse.json(
        {
          error: `Shopify rejected the order for ${order.shipTo}.`,
          details: gql.errors ?? errs,
          createdSoFar: created,
        },
        { status: 502 },
      );
    }
    const draft = gql.data.draftOrderCreate.draftOrder;
    created.push({
      shipTo: order.shipTo,
      draftOrderId: draft.id,
      invoiceUrl: draft.invoiceUrl,
    });
  }

  return NextResponse.json({ dryRun: false, orders: created });
}
