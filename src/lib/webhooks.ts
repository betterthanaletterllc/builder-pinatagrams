import { shopifyAdmin, shopifyTokenScope } from "./shopify";

/**
 * The builder's Shopify webhook subscriptions, kept in place BY the builder.
 *
 * The builder's own Shopify app creates them with its client credentials, so
 * Shopify signs every delivery with that app's secret — SHOPIFY_CLIENT_SECRET,
 * the key /api/webhooks/orders-paid already verifies against. (A webhook
 * created in Shopify admin → Notifications would be signed with a different
 * key; that path still works if SHOPIFY_WEBHOOK_SECRET is set to it.)
 *
 * Idempotent: a subscription to the same address is left alone. Runs from the
 * daily ensure-webhooks cron and once per server instance after a production
 * checkout, so a fresh deploy registers itself within its first orders.
 */

export const ORDERS_PAID_WEBHOOK_URI =
  "https://builder.pinatagrams.com/api/webhooks/orders-paid";

// Only what the handler reads. No customer, email, phone or address fields
// are ever delivered to the builder.
const ORDERS_PAID_FIELDS = [
  "id",
  "tags",
  "currency",
  "current_total_price",
  "current_subtotal_price",
  "total_discounts",
  "processed_at",
  "created_at",
  "note_attributes",
  "line_items",
  "discount_codes",
];

export type WebhookEnsure =
  | { status: "exists"; id: string }
  | { status: "created"; id: string }
  | { status: "skipped"; reason: string }
  | { status: "error"; reason: string };

const LIST_QUERY = `query {
  webhookSubscriptions(first: 50, topics: [ORDERS_PAID]) { nodes { id uri } }
}`;

const CREATE_MUTATION = `mutation($sub: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: ORDERS_PAID, webhookSubscription: $sub) {
    webhookSubscription { id uri }
    userErrors { field message }
  }
}`;

type ListData = { webhookSubscriptions: { nodes: { id: string; uri: string }[] } };
type CreateData = {
  webhookSubscriptionCreate: {
    webhookSubscription: { id: string; uri: string } | null;
    userErrors: { field: string[] | null; message: string }[];
  };
};

function failure(e: unknown): WebhookEnsure {
  const msg = e instanceof Error ? e.message : String(e);
  // orders/paid needs read_orders on the app — say so plainly in the log.
  const scope = shopifyTokenScope();
  const hint =
    scope && !/\b(read|write)_orders\b/.test(scope)
      ? " — the builder's Shopify app needs the read_orders scope for orders/paid"
      : "";
  return { status: "error", reason: `${msg}${hint}`.slice(0, 300) };
}

/** Is the orders/paid webhook subscribed? Read-only. */
export async function ordersPaidWebhookStatus(): Promise<
  { subscribed: boolean } | { subscribed: null; reason: string }
> {
  if (process.env.VERCEL_ENV !== "production") {
    return { subscribed: null, reason: "only checked in production" };
  }
  const gql = await shopifyAdmin();
  if (!gql) return { subscribed: null, reason: "Shopify credentials not configured" };
  try {
    const data = await gql<ListData>(LIST_QUERY);
    return {
      subscribed: data.webhookSubscriptions.nodes.some((n) => n.uri === ORDERS_PAID_WEBHOOK_URI),
    };
  } catch (e) {
    const f = failure(e);
    return { subscribed: null, reason: f.status === "error" ? f.reason : "unknown" };
  }
}

/** Subscribe orders/paid to the builder unless it already is. */
export async function ensureOrdersPaidWebhook(): Promise<WebhookEnsure> {
  // Previews and local dev never register their own URLs on the live store.
  if (process.env.VERCEL_ENV !== "production") {
    return { status: "skipped", reason: "not production" };
  }
  const gql = await shopifyAdmin();
  if (!gql) return { status: "skipped", reason: "Shopify credentials not configured" };
  try {
    const list = await gql<ListData>(LIST_QUERY);
    const hit = list.webhookSubscriptions.nodes.find((n) => n.uri === ORDERS_PAID_WEBHOOK_URI);
    if (hit) return { status: "exists", id: hit.id };
    const res = await gql<CreateData>(CREATE_MUTATION, {
      sub: { uri: ORDERS_PAID_WEBHOOK_URI, format: "JSON", includeFields: ORDERS_PAID_FIELDS },
    });
    const { webhookSubscription, userErrors } = res.webhookSubscriptionCreate;
    if (userErrors.length || !webhookSubscription) {
      return {
        status: "error",
        reason: userErrors.map((u) => u.message).join("; ") || "no subscription returned",
      };
    }
    return { status: "created", id: webhookSubscription.id };
  } catch (e) {
    return failure(e);
  }
}

let attempted: Promise<WebhookEnsure> | null = null;

/** One attempt per server instance, whatever the outcome (the daily cron is
 *  the retry path) — so a missing scope can't add a Shopify call to every
 *  checkout. Logs the result once. */
export function ensureOrdersPaidWebhookOnce(): Promise<WebhookEnsure> {
  attempted ??= ensureOrdersPaidWebhook().then((r) => {
    const detail = "reason" in r ? r.reason : r.id;
    if (r.status === "error") console.error(`orders/paid webhook: error — ${detail}`);
    else console.log(`orders/paid webhook: ${r.status} (${detail})`);
    return r;
  });
  return attempted;
}
