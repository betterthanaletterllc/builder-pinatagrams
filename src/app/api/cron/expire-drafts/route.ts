import { NextResponse } from "next/server";
import { catalogUrl, type HubCatalog } from "@/lib/hub";
import {
  minDeliveryDate,
  resolveDeliveryConfig,
  type Carrier,
  type DeliveryConfig,
} from "@/lib/delivery";
import {
  DRAFT_EXPIRY_MIN_AGE_MS,
  draftExpiry,
  shopifyCreds,
  shopifyGraphql,
  unpaidBuilderDraft,
  type Attr,
  type GqlResponse,
  type ShopifyCreds,
} from "@/lib/shopify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily sweep of builder draft orders nobody paid for and nobody CAN pay for
 * any more: unpaid (OPEN or INVOICE_SENT), tagged `builder`, older than 24h,
 * and carrying a delivery date the calendar can no longer make (a line's
 * `_requestedDate` is before today's earliest arrival for its `_carrier`,
 * FedEx by default — the same delivery.ts rules checkout applies). Paying one
 * would book a date we'd miss; deleted, it reads "gone" to the order-status
 * check, and the customer re-picks a date instead of paying a stale invoice.
 *
 * SAFETY:
 * - DRY RUN unless DRAFT_EXPIRY_MODE === "delete": it reports and logs what it
 *   WOULD delete, and deletes nothing.
 * - At most 50 deletions per run; each draft is re-read right before its
 *   delete (a customer may have paid since the scan) and must STILL be an
 *   unpaid builder draft. Completed drafts, drafts that spawned an order, and
 *   drafts without the builder tag are never touched.
 * - The delivery calendar comes from the hub exactly as checkout reads it;
 *   hub unreachable → no run (a wrong calendar must never decide a delete).
 *
 * Vercel Cron invokes this with `Authorization: Bearer ${CRON_SECRET}` when
 * that env var is set. Fails closed: no secret configured → 503 and no
 * deletions, ever.
 */

const MAX_DELETIONS = 50;
const PAGE_SIZE = 25;
// 25 × 20 = up to 500 unpaid drafts scanned per status per run; the oldest
// come first (id order), so a backlog drains across runs.
const MAX_PAGES_PER_STATUS = 20;
const HUB_TIMEOUT_MS = 5_000;
// Stop STARTING work well inside maxDuration (each Shopify call may take up
// to its 10s deadline).
const TIME_BUDGET_MS = 40_000;

// The unpaid statuses, one scan each (plain filters the search reads
// unambiguously). COMPLETED is never queried.
const UNPAID_STATUSES = ["open", "invoice_sent"] as const;

type ScanNode = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  tags: string[];
  order: { id: string } | null;
  lineItems: { nodes: { customAttributes: Attr[] }[] };
};

// 25 drafts × 25 lines keeps the query's cost well under Shopify's 1,000-point
// single-query cap (a builder draft has ≤ 20 piñata lines + its add-ons).
const SCAN_QUERY = `query($q: String!, $after: String) {
  draftOrders(first: ${PAGE_SIZE}, after: $after, query: $q) {
    nodes {
      id
      name
      status
      createdAt
      tags
      order { id }
      lineItems(first: 25) { nodes { customAttributes { key value } } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A GraphQL call that waits out Shopify's cost throttle (a long scan can
 *  drain the bucket) — up to three tries. Throws on transport failure. */
async function gql<T>(
  creds: ShopifyCreds,
  query: string,
  variables: Record<string, unknown>,
): Promise<GqlResponse<T>> {
  for (let attempt = 1; ; attempt++) {
    const r = await shopifyGraphql<T>(creds, query, variables);
    const throttled = r.errors?.some(
      (e) => (e as { extensions?: { code?: string } })?.extensions?.code === "THROTTLED",
    );
    if (!throttled || attempt >= 3) return r;
    await sleep(2_000 * attempt);
  }
}

/** The hub's delivery calendar (global, same block checkout reads), or null. */
async function hubDeliveryConfig(): Promise<DeliveryConfig | null> {
  try {
    const res = await fetch(catalogUrl(), {
      cache: "no-store",
      signal: AbortSignal.timeout(HUB_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const catalog = (await res.json()) as HubCatalog;
    return catalog && typeof catalog === "object"
      ? resolveDeliveryConfig(catalog.delivery)
      : null;
  } catch {
    return null;
  }
}

type Candidate = {
  id: string;
  name: string;
  createdAt: string;
  requestedDate: string;
  carrier: Carrier;
  earliest: string;
};

export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "CRON_SECRET not configured — refusing to run." },
      { status: 503 },
    );
  }
  if (req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  const mode = process.env.DRAFT_EXPIRY_MODE === "delete" ? "delete" : "dry-run";
  const creds = shopifyCreds();
  if (!creds) {
    return NextResponse.json(
      { mode, error: "Shopify credentials aren't configured — nothing to sweep." },
      { status: 503 },
    );
  }
  const cfg = await hubDeliveryConfig();
  if (!cfg) {
    console.error("expire-drafts: hub delivery calendar unreachable — skipped this run");
    return NextResponse.json(
      { mode, error: "Hub delivery calendar unreachable — refusing to judge dates without it." },
      { status: 503 },
    );
  }

  const started = Date.now();
  const outOfTime = () => Date.now() - started > TIME_BUDGET_MS;
  // Today's earliest arrival per carrier (shop timezone), computed once.
  const earliestByCarrier = new Map<Carrier, string>();
  const earliestFor = (c: Carrier) => {
    if (!earliestByCarrier.has(c)) earliestByCarrier.set(c, minDeliveryDate(cfg, c));
    return earliestByCarrier.get(c)!;
  };
  // Search pre-filter only; draftExpiry re-checks age, status and tag itself.
  const cutoff = new Date(started - DRAFT_EXPIRY_MIN_AGE_MS)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");

  let scanned = 0;
  let scanIncomplete = false;
  const candidates: Candidate[] = [];
  try {
    for (const status of UNPAID_STATUSES) {
      let after: string | null = null;
      for (let page = 0; page < MAX_PAGES_PER_STATUS; page++) {
        if (outOfTime()) {
          scanIncomplete = true;
          break;
        }
        const r: GqlResponse<{
          draftOrders: {
            nodes: ScanNode[];
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
          };
        }> = await gql(creds, SCAN_QUERY, {
          q: `status:${status} tag:builder created_at:<'${cutoff}'`,
          after,
        });
        if (r.status !== 200 || r.errors || !r.data?.draftOrders) {
          console.error(`expire-drafts: scan failed (HTTP ${r.status})`, JSON.stringify(r.body));
          scanIncomplete = true;
          break;
        }
        const conn = r.data.draftOrders;
        for (const n of conn.nodes ?? []) {
          scanned++;
          const verdict = draftExpiry(
            {
              status: n.status,
              tags: n.tags ?? [],
              order: n.order,
              createdAt: n.createdAt,
              lineAttributes: (n.lineItems?.nodes ?? []).map((li) => li.customAttributes ?? []),
            },
            started,
            earliestFor,
          );
          if (verdict.expire) {
            candidates.push({
              id: n.id,
              name: n.name,
              createdAt: n.createdAt,
              requestedDate: verdict.requestedDate,
              carrier: verdict.carrier,
              earliest: verdict.earliest,
            });
          }
        }
        if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
        after = conn.pageInfo.endCursor;
        if (page === MAX_PAGES_PER_STATUS - 1) scanIncomplete = true;
      }
    }
  } catch (e) {
    console.error(`expire-drafts: scan failed: ${errText(e)}`);
    scanIncomplete = true;
  }

  // Oldest first, capped: a backlog drains over several runs.
  candidates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const batch = candidates.slice(0, MAX_DELETIONS);
  const describe = (c: Candidate) =>
    `${c.id} (${c.name}, created ${c.createdAt}): ${c.carrier} date ${c.requestedDate} is before today's earliest ${c.earliest}`;

  if (mode === "dry-run") {
    for (const c of batch) console.log(`expire-drafts [dry-run] would delete ${describe(c)}`);
    console.log(
      `expire-drafts [dry-run]: scanned ${scanned}, ${candidates.length} expired, would delete ${batch.length} (set DRAFT_EXPIRY_MODE=delete to act)`,
    );
    return NextResponse.json({
      mode,
      scanned,
      scanIncomplete,
      expired: candidates.length,
      wouldDelete: batch,
    });
  }

  const deleted: string[] = [];
  const skipped: { id: string; reason: string }[] = [];
  const failed: { id: string; reason: string }[] = [];
  for (const c of batch) {
    if (outOfTime()) {
      skipped.push({ id: c.id, reason: "time budget — next run" });
      continue;
    }
    try {
      // Re-read right before deleting: the customer may have paid since the
      // scan. Anything but a still-unpaid builder draft is left alone.
      const fresh = await gql<{
        draftOrder: { status: string; tags: string[]; order: { id: string } | null } | null;
      }>(
        creds,
        `query($id: ID!) { draftOrder(id: $id) { status tags order { id } } }`,
        { id: c.id },
      );
      if (fresh.status !== 200 || fresh.errors || !fresh.data) {
        failed.push({ id: c.id, reason: `re-check failed (HTTP ${fresh.status})` });
        continue;
      }
      const d = fresh.data.draftOrder;
      if (!d) {
        skipped.push({ id: c.id, reason: "already gone" });
        continue;
      }
      if (!unpaidBuilderDraft({ status: d.status, tags: d.tags ?? [], order: d.order })) {
        skipped.push({ id: c.id, reason: `no longer an unpaid builder draft (status ${d.status})` });
        continue;
      }
      const del = await gql<{
        draftOrderDelete: { deletedId: string | null; userErrors: { message?: string }[] } | null;
      }>(
        creds,
        `mutation($input: DraftOrderDeleteInput!) {
          draftOrderDelete(input: $input) { deletedId userErrors { field message } }
        }`,
        { input: { id: c.id } },
      );
      const out = del.data?.draftOrderDelete;
      if (del.status === 200 && !del.errors && out?.deletedId && !out.userErrors?.length) {
        deleted.push(c.id);
        console.log(`expire-drafts: deleted ${describe(c)}`);
      } else {
        failed.push({ id: c.id, reason: `delete refused (HTTP ${del.status})` });
        console.error(`expire-drafts: delete ${c.id} refused`, JSON.stringify(del.body));
      }
    } catch (e) {
      failed.push({ id: c.id, reason: errText(e) });
      console.error(`expire-drafts: ${c.id}: ${errText(e)}`);
    }
  }

  console.log(
    `expire-drafts: scanned ${scanned}, ${candidates.length} expired, deleted ${deleted.length}, skipped ${skipped.length}, failed ${failed.length}`,
  );
  return NextResponse.json({
    mode,
    scanned,
    scanIncomplete,
    expired: candidates.length,
    deleted,
    skipped,
    failed,
  });
}
