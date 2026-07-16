import { NextResponse } from "next/server";
import { rateLimit, clientIp } from "@/lib/rate-limit";
import { shopifyAdmin } from "@/lib/shopify";

/**
 * Is the draft order behind a "pending" cart already paid? The builder gets no
 * payment webhook, so the cart page asks here on load: a COMPLETED draft (or
 * one that has spawned an order) means the customer paid on the hosted invoice
 * — the cart page then clears itself instead of showing the paid order again.
 *
 * Returns only a coarse status (never order details); rate-limited so the draft
 * gid can't be enumerated en masse.
 */

const DRAFT_GID_RE = /^gid:\/\/shopify\/DraftOrder\/\d+$/;

export async function POST(req: Request) {
  if (!rateLimit(`orderstatus:${clientIp(req)}`, 30, 60_000)) {
    return NextResponse.json({ status: "unknown" }, { status: 429 });
  }

  let draftOrderId = "";
  try {
    const body = (await req.json()) as { draftOrderId?: unknown };
    if (typeof body?.draftOrderId === "string") draftOrderId = body.draftOrderId;
  } catch {
    /* fall through to invalid */
  }
  if (!DRAFT_GID_RE.test(draftOrderId)) {
    return NextResponse.json({ status: "unknown" });
  }

  try {
    const gql = await shopifyAdmin();
    // Creds not configured (e.g. local dev) — don't disturb the cart.
    if (!gql) return NextResponse.json({ status: "unknown" });

    const data = await gql<{
      draftOrder: { status: string; order: { id: string } | null } | null;
    }>(`query($id: ID!) { draftOrder(id: $id) { status order { id } } }`, {
      id: draftOrderId,
    });

    const draft = data.draftOrder;
    if (!draft) return NextResponse.json({ status: "gone" }); // deleted/cleaned up
    // A paid invoice completes the draft and spawns an order.
    if (draft.status === "COMPLETED" || draft.order) {
      return NextResponse.json({ status: "paid" });
    }
    return NextResponse.json({ status: "unpaid" });
  } catch {
    // Any failure: leave the cart exactly as it is.
    return NextResponse.json({ status: "unknown" });
  }
}
