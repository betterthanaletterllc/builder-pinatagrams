import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { after, NextResponse } from "next/server";
import { POSTHOG_HOST, POSTHOG_KEY } from "@/lib/analytics-config";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import { ensureOrdersPaidWebhookOnce, ordersPaidWebhookStatus } from "@/lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Shopify `orders/paid` → PostHog `order_paid`: the funnel's true end.
 *
 * The browser can only report a purchase if the payer comes back to the
 * builder, so the paid order itself tells PostHog. Checkout stamps the
 * shopper's PostHog ids on the order as ORDER-LEVEL custom attributes
 * (`_phDistinctId`, `_phSessionId` — never the note, which Paper prints as the
 * gift message); Shopify delivers those back here as `note_attributes`, which
 * joins the paid order to the session and experiment arm that built it.
 *
 * Setup: none. The builder subscribes `orders/paid` to
 *   https://builder.pinatagrams.com/api/webhooks/orders-paid
 * itself through its own Shopify app (lib/webhooks — after production
 * checkouts and from the daily ensure-webhooks cron), so deliveries are signed
 * with SHOPIFY_CLIENT_SECRET. A webhook added by hand in Shopify admin →
 * Settings → Notifications is signed with the key shown there instead — put
 * it in SHOPIFY_WEBHOOK_SECRET; either key is accepted. Without a secret the
 * route refuses every call rather than trusting unsigned payloads.
 * `GET` answers whether the subscription exists (rate-limited; its first
 * call on an instance also creates the subscription if it's missing).
 *
 * Only orders tagged `builder` are forwarded. Nothing personal leaves this
 * route: no names, emails, addresses or messages — just counts, money and
 * the builder's own rails (host, variant, carrier, graphic mix).
 */

type Attr = { name?: string; value?: unknown };
type LineItem = { quantity?: number; properties?: Attr[] };
type PaidOrder = {
  id?: number;
  tags?: string;
  currency?: string;
  current_total_price?: string;
  current_subtotal_price?: string;
  total_discounts?: string;
  processed_at?: string;
  created_at?: string;
  note_attributes?: Attr[];
  line_items?: LineItem[];
  discount_codes?: unknown[];
};

function verified(raw: string, hmacHeader: string | null, secret: string): boolean {
  if (!hmacHeader) return false;
  const digest = createHmac("sha256", secret).update(raw, "utf8").digest();
  let given: Buffer;
  try {
    given = Buffer.from(hmacHeader, "base64");
  } catch {
    return false;
  }
  return given.length === digest.length && timingSafeEqual(given, digest);
}

const attr = (list: Attr[] | undefined, name: string): string | undefined => {
  const hit = list?.find((a) => a?.name === name)?.value;
  return typeof hit === "string" && hit.trim() ? hit.trim() : undefined;
};

/** A stable UUID per order, so Shopify's webhook retries don't count twice
 *  (PostHog de-duplicates events that share a uuid). */
function orderUuid(orderId: number): string {
  const h = createHash("sha256").update(`order_paid:${orderId}`).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const money = (v: string | undefined): number | undefined => {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** Is Shopify's orders/paid subscribed to this route? The first look on each
 *  instance also subscribes it if it's missing (idempotent, same as the
 *  cron) — so a deploy can be checked, and fixed, from a browser. */
export async function GET(req: Request) {
  if (!rateLimit(`webhook-status:${clientIp(req)}`, 5, 60_000)) {
    return NextResponse.json({ error: "Too many requests." }, { status: 429 });
  }
  const ensured = await ensureOrdersPaidWebhookOnce();
  const status = await ordersPaidWebhookStatus();
  return NextResponse.json(
    { ...status, ...(ensured.status === "error" ? { error: ensured.reason } : {}) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request) {
  // The builder's own subscription is signed with the app's client secret; a
  // hand-made admin webhook with SHOPIFY_WEBHOOK_SECRET. Accept either.
  const secrets = [process.env.SHOPIFY_WEBHOOK_SECRET, process.env.SHOPIFY_CLIENT_SECRET]
    .filter((s): s is string => Boolean(s));
  if (!secrets.length) {
    return NextResponse.json({ error: "Webhook secret not configured." }, { status: 503 });
  }
  const raw = await req.text();
  const hmac = req.headers.get("x-shopify-hmac-sha256");
  if (!secrets.some((s) => verified(raw, hmac, s))) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }
  const topic = req.headers.get("x-shopify-topic");
  if (topic && topic !== "orders/paid") {
    return NextResponse.json({ ok: true, ignored: `topic ${topic}` });
  }

  let order: PaidOrder;
  try {
    order = JSON.parse(raw) as PaidOrder;
  } catch {
    return NextResponse.json({ error: "Bad payload." }, { status: 400 });
  }
  const tags = (order.tags ?? "").split(",").map((t) => t.trim()).filter(Boolean);
  if (!tags.includes("builder") || typeof order.id !== "number") {
    return NextResponse.json({ ok: true, ignored: "not a builder order" });
  }

  const notes = order.note_attributes;
  const host = attr(notes, "_builderHost");
  const lines = order.line_items ?? [];
  // Piñata lines carry _bodyStyle; add-on lines don't.
  const pinatas = lines.filter((l) => attr(l.properties, "_bodyStyle"));
  const units = pinatas.reduce((s, l) => s + (l.quantity ?? 1), 0);
  const tierOf = (l: LineItem) =>
    attr(l.properties, "_frontGraphicSha256")
      ? "custom"
      : attr(l.properties, "_design") === "STANDARD"
        ? "classic"
        : "library";
  const leadDays = (() => {
    const placed = Date.parse(order.processed_at ?? order.created_at ?? "");
    const dates = pinatas
      .map((l) => Date.parse(`${attr(l.properties, "_requestedDate") ?? ""}T12:00:00-05:00`))
      .filter(Number.isFinite);
    if (!Number.isFinite(placed) || !dates.length) return undefined;
    return Math.round((Math.min(...dates) - placed) / 86_400_000);
  })();

  const distinctId = attr(notes, "_phDistinctId") ?? `shopify_order_${order.id}`;
  const sessionId = attr(notes, "_phSessionId");
  const properties: Record<string, unknown> = {
    // Revenue for PostHog's revenue analytics + the experiment readout.
    revenue: money(order.current_total_price),
    currency: order.currency ?? "USD",
    subtotal: money(order.current_subtotal_price),
    discounts: money(order.total_discounts),
    has_discount_code: Array.isArray(order.discount_codes) && order.discount_codes.length > 0,
    units,
    lines: pinatas.length,
    classic_units: pinatas.filter((l) => tierOf(l) === "classic").length,
    library_units: pinatas.filter((l) => tierOf(l) === "library").length,
    custom_units: pinatas.filter((l) => tierOf(l) === "custom").length,
    addon_lines: pinatas.filter((l) => attr(l.properties, "_addons")).length,
    carrier: attr(pinatas[0]?.properties, "_carrier") ?? "fedex",
    lead_time_days: leadDays,
    store_host: host,
    flow_version: host === "builder2.pinatagrams.com" ? "v2" : "v1",
    variant: tags.find((t) => t.startsWith("variant-"))?.slice("variant-".length),
    joined_to_session: Boolean(attr(notes, "_phDistinctId")),
    ...(sessionId ? { $session_id: sessionId } : {}),
    $process_person_profile: Boolean(attr(notes, "_phDistinctId")),
  };

  // Answer Shopify at once (it retries on slow replies); tell PostHog after.
  after(async () => {
    try {
      const res = await fetch(`${POSTHOG_HOST.replace(/\/$/, "")}/capture/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: POSTHOG_KEY,
          event: "order_paid",
          distinct_id: distinctId,
          uuid: orderUuid(order.id!),
          timestamp: order.processed_at ?? order.created_at,
          properties,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) console.error("orders-paid: PostHog capture failed", res.status);
    } catch (e) {
      console.error("orders-paid: PostHog capture error", e);
    }
  });

  return NextResponse.json({ ok: true });
}
