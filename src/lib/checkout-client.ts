/**
 * The ONE client path into /api/checkout — v1's cart and v2's Deliver & pay
 * step both call startCheckout(). It sends a SELECTION (lines, codes, an
 * optional email, analytics ids, the draft this order replaces), never a
 * price; reads whatever comes back defensively (non-JSON, network drop,
 * timeout → a friendly `error`); fires the checkout funnel events; and on
 * success moves the drafted lines out of the active cart onto a pending
 * order. The CALLER redirects (window.location.assign(invoiceUrl)), so it
 * keeps control of its busy state and of the dry-run display.
 *
 * Also home to the pending-order paid check: the builder gets no payment
 * webhook, so the header asks /api/order-status on every page (throttled
 * per record) whether a waiting draft was paid (clear it, close the funnel)
 * or deleted (put its lines back in the cart).
 */

import {
  addressKey,
  clearPendingOrder,
  clearSupersede,
  loadPendingOrders,
  loadSupersede,
  pendingKey,
  recordCheckout,
  restorePendingToCart,
  updatePendingOrders,
  type CartLine,
  type PendingOrder,
} from "./flow";
import { formatYmd } from "./delivery";
import { track, trackBeginCheckout } from "./analytics";
import { readAnalyticsIds } from "./analytics-ids";
import { previewVariantName } from "./variant";

export type LineError = { lineId: string; code: string; message: string };

export type CheckoutResult =
  | { ok: true; kind: "redirect"; invoiceUrl: string; draftOrderId: string }
  | { ok: true; kind: "dry-run"; payload: unknown }
  | { ok: false; status: number; error: string; lineErrors?: LineError[] };

// Generous on purpose: the route makes several hub + Shopify round trips in
// series. Giving up early doesn't stop the server — it only strands a draft
// and invites a duplicate when the shopper retries.
const CHECKOUT_TIMEOUT_MS = 45_000;

const COPY = {
  empty: "Your cart is empty.",
  network: "We couldn't reach checkout — check your connection and try again.",
  timeout:
    "Checkout is taking too long to answer — check your connection and try again. You haven't been charged.",
  invalid: "Checkout sent back something unexpected — please try again.",
  rateLimited: "Too many checkout attempts — give it a minute and try again.",
  server: "Checkout hit a snag on our end — please try again in a moment.",
  rejected: "We couldn't start checkout — check your cart and try again.",
  partial:
    "Part of your order went through and is waiting for payment. The rest couldn't be created — please try again.",
};

/** "v1" | "v2" — the flow that rendered this page (layout sets it). */
function flowVersion(): string {
  try {
    return document.body.dataset.flow || "v1";
  } catch {
    return "v1";
  }
}

// Server messages still carry raw YYYY-MM-DD dates in places; the shopper
// reads "Thu, Oct 1".
function readable(msg: string): string {
  return msg.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (d) => formatYmd(d));
}

function httpsUrl(u: unknown): u is string {
  if (typeof u !== "string") return false;
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
}

type CreatedOrder = {
  invoiceUrl: string;
  draftOrderId: string;
  groupKey: string;
  nonce?: string;
};

// Never redirect anywhere but an https invoice.
function parseOrders(v: unknown): CreatedOrder[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((o): CreatedOrder[] => {
    if (!o || typeof o !== "object") return [];
    const r = o as Record<string, unknown>;
    if (typeof r.draftOrderId !== "string" || !r.draftOrderId) return [];
    if (!httpsUrl(r.invoiceUrl)) return [];
    return [
      {
        invoiceUrl: r.invoiceUrl,
        draftOrderId: r.draftOrderId,
        groupKey: typeof r.groupKey === "string" ? r.groupKey : "",
        ...(typeof r.nonce === "string" && r.nonce ? { nonce: r.nonce } : {}),
      },
    ];
  });
}

/** Which lines each created draft holds. The server groups by the address
 *  key; one draft (the single-address norm) simply holds everything sent.
 *  `every` = a success: a line matching no group still went somewhere, so
 *  it rides the first draft. A partial failure moves only matched lines. */
function linesPerOrder(
  orders: CreatedOrder[],
  lines: CartLine[],
  every: boolean,
): CartLine[][] {
  if (every && orders.length === 1) return [lines];
  const out = orders.map((): CartLine[] => []);
  for (const l of lines) {
    const i = orders.findIndex((o) => o.groupKey === addressKey(l.address));
    if (i >= 0) out[i].push(l);
    else if (every) out[0].push(l);
  }
  return out;
}

function parseLineErrors(v: unknown): LineError[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.flatMap((e): LineError[] => {
    if (!e || typeof e !== "object") return [];
    const r = e as Record<string, unknown>;
    if (typeof r.lineId !== "string" || typeof r.message !== "string") return [];
    return [
      {
        lineId: r.lineId,
        code: typeof r.code === "string" && r.code ? r.code : "line",
        message: readable(r.message),
      },
    ];
  });
  return out.length ? out : undefined;
}

// Until the server sends lineErrors, its one error names the line by
// position ("Piñata 2: …", counted over the lines as sent). \S{1,2}
// matches the ñ whether it arrives composed or decomposed.
function legacyLineError(error: string, lines: CartLine[]): LineError[] | undefined {
  const m = /^Pi\S{1,2}ata (\d+): ([\s\S]+)$/.exec(error);
  const line = m ? lines[Number(m[1]) - 1] : undefined;
  return line ? [{ lineId: line.id, code: "line", message: m![2] }] : undefined;
}

// The server prices from ids and prints from the uploaded Blob URLs
// (art/designUrl/artSha256) — it never reads the embedded design document
// or the preview data URL. Null ONLY those two on the POST (photo-heavy
// customs would otherwise blow Vercel's ~4.5 MB body cap); the spread keeps
// every other field — checkout hard-requires artSha256 for blob art, and an
// allowlist here would silently drop the next field someone adds.
function forTheWire(l: CartLine): CartLine {
  return l.graphic.type === "custom"
    ? ({
        ...l,
        graphic: { ...l.graphic, design: null, preview: "" },
      } as unknown as CartLine)
    : l;
}

function failed(
  status: number,
  reason: string,
  error: string,
  lineErrors?: LineError[],
): CheckoutResult {
  track("checkout_failed", {
    flow_version: flowVersion(),
    status,
    reason,
    line_errors: lineErrors?.length ?? 0,
  });
  return { ok: false, status, error, ...(lineErrors ? { lineErrors } : {}) };
}

let inflight: Promise<CheckoutResult> | null = null;

/**
 * Create the Shopify draft for these lines and return where to pay. On a
 * redirect result the lines have already left the active cart (they wait on
 * a pending order); on any failure the cart is untouched — except lines
 * whose draft WAS created in a partial failure, which move to a pending
 * order so a retry can't order them twice. `valueCents` (optional) is the
 * page's display total, used only as the begin_checkout event value.
 */
export function startCheckout(opts: {
  lines: CartLine[];
  discountCodes: string[];
  email?: string | null;
  valueCents?: number | null;
}): Promise<CheckoutResult> {
  // A double tap — or the panel button and the sticky bar both — joins the
  // checkout already in flight instead of creating a second draft.
  if (inflight) return inflight;
  const p = runCheckout(opts).finally(() => {
    if (inflight === p) inflight = null;
  });
  inflight = p;
  return p;
}

async function runCheckout(opts: {
  lines: CartLine[];
  discountCodes: string[];
  email?: string | null;
  valueCents?: number | null;
}): Promise<CheckoutResult> {
  const lines = opts.lines;
  if (!lines.length) return failed(0, "empty", COPY.empty);
  trackBeginCheckout(opts.valueCents ?? null);

  // Every applied CODE, never a claimed amount; Shopify enforces each
  // code's rules and skips any that doesn't qualify.
  const codes = [
    ...new Set(
      opts.discountCodes.map((c) => c.trim().toUpperCase()).filter(Boolean),
    ),
  ].slice(0, 2);
  const email = typeof opts.email === "string" ? opts.email.trim() : "";
  const analytics = readAnalyticsIds();
  const supersedes = loadSupersede();
  const preview = previewVariantName();
  const body = {
    lines: lines.map(forTheWire),
    ...(codes.length ? { discountCodes: codes } : {}),
    ...(email ? { email } : {}),
    ...(Object.keys(analytics).length ? { analytics } : {}),
    ...(supersedes ? { supersedes } : {}),
    // Non-production preview sitting: checkout must price the SAME profile
    // the page displayed. The server ignores this field in production.
    ...(preview ? { previewVariant: preview } : {}),
  };

  let res: Response;
  let text: string;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CHECKOUT_TIMEOUT_MS);
  try {
    res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    text = await res.text();
  } catch {
    return ctrl.signal.aborted
      ? failed(0, "timeout", COPY.timeout)
      : failed(0, "network", COPY.network);
  } finally {
    clearTimeout(timer);
  }

  let data: Record<string, unknown> | null = null;
  try {
    const j: unknown = JSON.parse(text);
    if (j && typeof j === "object" && !Array.isArray(j)) data = j as Record<string, unknown>;
  } catch {
    /* an HTML error page, a proxy's plain text — handled below */
  }

  if (res.ok && data) {
    if (data.dryRun === true) {
      track("checkout_succeeded", {
        flow_version: flowVersion(),
        kind: "dry-run",
        lines: lines.length,
      });
      return { ok: true, kind: "dry-run", payload: data };
    }
    const orders = data.dryRun === false ? parseOrders(data.orders) : [];
    if (!orders.length) return failed(res.status, "invalid_response", COPY.invalid);
    const groups = linesPerOrder(orders, lines, true);
    const now = Date.now();
    const recorded = recordCheckout(
      orders.map((o, i) => ({
        invoiceUrl: o.invoiceUrl,
        draftOrderId: o.draftOrderId,
        ...(o.nonce ? { nonce: o.nonce } : {}),
        createdAt: now,
        lines: groups[i],
        ...(orders.length === 1 && typeof opts.valueCents === "number"
          ? { valueCents: opts.valueCents }
          : {}),
      })),
    );
    // The server has acted on (or refused) the draft this one replaces.
    if (supersedes) clearSupersede();
    track("checkout_succeeded", {
      flow_version: flowVersion(),
      kind: "redirect",
      orders: orders.length,
      lines: lines.length,
      units: lines.reduce((s, l) => s + l.qty, 0),
      value:
        typeof opts.valueCents === "number" ? opts.valueCents / 100 : undefined,
      currency: "USD",
      supersedes: !!supersedes,
      recorded,
    });
    return {
      ok: true,
      kind: "redirect",
      invoiceUrl: orders[0].invoiceUrl,
      draftOrderId: orders[0].draftOrderId,
    };
  }

  // Failure. A multi-destination partial failure created some drafts: those
  // lines leave the cart NOW so a retry can't order them twice.
  // (Single-address carts can't partially fail — this is a guard.)
  const created = parseOrders(data?.createdSoFar);
  if (created.length) {
    const groups = linesPerOrder(created, lines, false);
    const now = Date.now();
    recordCheckout(
      created
        .map((o, i) => ({
          invoiceUrl: o.invoiceUrl,
          draftOrderId: o.draftOrderId,
          ...(o.nonce ? { nonce: o.nonce } : {}),
          createdAt: now,
          lines: groups[i],
        }))
        .filter((o) => o.lines.length),
    );
  }
  const serverError =
    typeof data?.error === "string" && data.error.trim() ? readable(data.error.trim()) : "";
  const lineErrors =
    parseLineErrors(data?.lineErrors) ??
    (serverError ? legacyLineError(serverError, lines) : undefined);
  const status = res.status;
  // A 5xx is the server's trouble whatever its body (a gateway's HTML
  // timeout page included); a non-JSON body on anything else is garbled.
  const [reason, fallback] = created.length
    ? ["partial", COPY.partial]
    : lineErrors
      ? [lineErrors[0].code, COPY.rejected]
      : status >= 500
        ? ["server", COPY.server]
        : status === 429
          ? ["rate_limited", COPY.rateLimited]
          : !data || res.ok
            ? ["invalid_response", COPY.invalid]
            : ["rejected", COPY.rejected];
  return failed(
    status,
    reason,
    created.length ? COPY.partial : serverError || fallback,
    lineErrors,
  );
}

/* ---------------------------------------------------------------------------
 * Pending orders: paid / gone checks.
 * ------------------------------------------------------------------------- */

export type PendingCheck = {
  paid: PendingOrder[];
  gone: PendingOrder[];
  // still unpaid — or unknown (status unavailable): either way, kept
  open: PendingOrder[];
};

// The global (every page) check asks about each record at most this often.
const CHECK_EVERY_MS = 10 * 60 * 1000;
// A forced check (the cart page, where "Change order" is decided) skips
// only records asked about a moment ago — e.g. by the header on this load.
const FORCE_FRESH_MS = 5 * 1000;
const STATUS_TIMEOUT_MS = 8 * 1000;

type DraftStatus = "paid" | "gone" | "open" | "unknown";

async function orderStatus(draftOrderId: string): Promise<DraftStatus> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), STATUS_TIMEOUT_MS);
  try {
    const r = await fetch("/api/order-status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ draftOrderId }),
      signal: ctrl.signal,
    });
    if (!r.ok) return "unknown";
    const s = ((await r.json()) as { status?: unknown } | null)?.status;
    if (s === "paid" || s === "gone") return s;
    return s === "unpaid" || s === "open" ? "open" : "unknown";
  } catch {
    return "unknown";
  } finally {
    clearTimeout(t);
  }
}

/** Remove a paid order's record and close the funnel — only the pass that
 *  actually removes it reports it, so each draft is confirmed once. */
function settlePaid(p: PendingOrder): boolean {
  const key = pendingKey(p);
  if (!loadPendingOrders().some((x) => pendingKey(x) === key)) return false;
  clearPendingOrder(key);
  // Store-side pixels own the real Purchase; this closes the PostHog/GA
  // funnel and joins it to the draft.
  track("purchase_confirmed", {
    flow_version: flowVersion(),
    draft_order_id: p.draftOrderId,
    value: typeof p.valueCents === "number" ? p.valueCents / 100 : undefined,
    currency: "USD",
    units: p.lines.reduce((s, l) => s + l.qty, 0),
  });
  return true;
}

/** Deleted draft (expired, replaced, or removed by staff): its lines go
 *  back in the cart. If the cart now ships somewhere else, they wait on
 *  the record (marked expired) until the cart can take them. */
function settleGone(p: PendingOrder): void {
  const key = pendingKey(p);
  if (!p.lines.length) {
    clearPendingOrder(key);
    return;
  }
  const r = restorePendingToCart(key, { supersede: false });
  if (!r.ok && r.reason !== "missing") updatePendingOrders([key], { expired: true });
}

async function runCheck(minAgeMs: number): Promise<PendingCheck> {
  const out: PendingCheck = { paid: [], gone: [], open: [] };
  const now = Date.now();
  const due = loadPendingOrders().filter(
    (p) => p.draftOrderId && !p.expired && now - (p.checkedAt ?? 0) >= minAgeMs,
  );
  if (!due.length) return out;
  // Stamp BEFORE asking, so another page or tab starting its own pass right
  // now skips these instead of asking twice.
  updatePendingOrders(due.map(pendingKey), { checkedAt: now });
  await Promise.all(
    due.map(async (p) => {
      const status = await orderStatus(p.draftOrderId!);
      if (status === "paid") {
        if (settlePaid(p)) out.paid.push(p);
      } else if (status === "gone") {
        settleGone(p);
        out.gone.push(p);
      } else {
        out.open.push(p);
      }
    }),
  );
  return out;
}

let checking: Promise<PendingCheck> | null = null;

/**
 * Ask Shopify about every waiting draft that's due (each at most once per
 * 10 minutes; `force` = the cart page, which needs a fresh answer before it
 * offers "Change order"). Paid → the record is cleared and
 * `purchase_confirmed` fires once; gone → its lines return to the cart;
 * open/unknown → kept. Concurrent calls share one pass. Never throws.
 */
export function checkPendingOrders(opts: { force?: boolean } = {}): Promise<PendingCheck> {
  const minAge = opts.force ? FORCE_FRESH_MS : CHECK_EVERY_MS;
  // Joining a pass already in flight: a forced caller then also asks about
  // whatever that (throttled) pass skipped.
  const next: Promise<PendingCheck> = checking
    ? checking.then(async (prev) => {
        if (!opts.force) return prev;
        const more = await runCheck(minAge);
        const settled = new Set([...more.paid, ...more.gone].map(pendingKey));
        return {
          paid: [...prev.paid, ...more.paid],
          gone: [...prev.gone, ...more.gone],
          open: [
            ...prev.open.filter((p) => !settled.has(pendingKey(p))),
            ...more.open,
          ],
        };
      })
    : runCheck(minAge);
  const p = next
    .catch((): PendingCheck => ({ paid: [], gone: [], open: [] }))
    .finally(() => {
      if (checking === p) checking = null;
    });
  checking = p;
  return p;
}

export type ReopenResult = "restored" | "paid" | "missing" | "address" | "full";

/**
 * "Change order" / "Add the waiting order to this one": re-ask Shopify first
 * (it may have been paid a moment ago in another tab — reopening a paid
 * order is how a piñata gets bought twice), then move the lines back into
 * the cart. The next checkout supersedes the old draft so the server can
 * delete it.
 */
export async function reopenPendingOrder(key: string): Promise<ReopenResult> {
  const p = loadPendingOrders().find((x) => pendingKey(x) === key);
  if (!p) return "missing";
  let status: DraftStatus = "unknown";
  if (p.draftOrderId && !p.expired) {
    status = await orderStatus(p.draftOrderId);
    if (status === "paid") {
      settlePaid(p);
      return "paid";
    }
  }
  const r = restorePendingToCart(key, { supersede: status !== "gone" });
  return r.ok ? "restored" : r.reason;
}

/** Back to a waiting order's invoice. Clears its throttle stamp first, so
 *  whichever builder page the shopper returns to re-checks right away. */
export function resumePayment(p: PendingOrder): void {
  updatePendingOrders([pendingKey(p)], { checkedAt: undefined });
  window.location.assign(p.invoiceUrl);
}
