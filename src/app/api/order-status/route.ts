import { NextResponse } from "next/server";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { shopifyAdmin } from "@/lib/shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where does the draft order behind a "pending" cart stand? The builder gets
 * no payment webhook, so the client asks here — on load, and (the global paid
 * check) at most every ~10 minutes per pending order:
 *
 *   paid    — the draft COMPLETED (or spawned an order): the customer paid on
 *             the hosted invoice; the client clears those lines.
 *   open    — still awaiting payment (OPEN, or INVOICE_SENT).
 *   gone    — no such draft any more: deleted (superseded by a newer checkout,
 *             expired by the daily sweep) or purged by Shopify. The lines
 *             were never bought.
 *   unknown — can't tell (malformed id, creds missing, Shopify hiccup, an
 *             unrecognized status): leave the cart exactly as it is.
 *
 * Returns only that coarse status — never order details, totals, names or
 * addresses; rate-limited so the draft gid can't be enumerated en masse.
 */

type OrderStatus = "paid" | "open" | "gone" | "unknown";

const DRAFT_GID_RE = /^gid:\/\/shopify\/DraftOrder\/\d+$/;

function reply(status: OrderStatus, httpStatus = 200): NextResponse {
  return NextResponse.json(
    { status },
    { status: httpStatus, headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  if (!rateLimit(`orderstatus:${clientIp(req)}`, 30, 60_000)) {
    return reply("unknown", 429);
  }

  let draftOrderId = "";
  try {
    const body = (await req.json()) as { draftOrderId?: unknown };
    if (typeof body?.draftOrderId === "string") draftOrderId = body.draftOrderId;
  } catch {
    /* fall through to invalid */
  }
  if (!DRAFT_GID_RE.test(draftOrderId)) return reply("unknown");

  try {
    const gql = await shopifyAdmin();
    // Creds not configured (e.g. local dev) — don't disturb the cart.
    if (!gql) return reply("unknown");

    const data = await gql<{
      draftOrder: { status: string; order: { id: string } | null } | null;
    }>(`query($id: ID!) { draftOrder(id: $id) { status order { id } } }`, {
      id: draftOrderId,
    });

    // "gone" only on Shopify's explicit null — never on a missing answer.
    const draft = data.draftOrder;
    if (draft === null) return reply("gone");
    if (!draft) return reply("unknown");
    // A paid invoice completes the draft and spawns an order.
    if (draft.status === "COMPLETED" || draft.order) return reply("paid");
    if (draft.status === "OPEN" || draft.status === "INVOICE_SENT") return reply("open");
    // A status this code doesn't know yet — don't guess either way.
    return reply("unknown");
  } catch {
    // Any failure (timeout included): leave the cart exactly as it is.
    return reply("unknown");
  }
}
