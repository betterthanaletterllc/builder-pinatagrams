import { track, trackBeginCheckout } from "./analytics";
import { savePendingOrder, type CartLine } from "./flow";
import { previewVariantName } from "./variant";

/**
 * Client checkout helper — the shared contract (implementation owned by the
 * cart/checkout workstream). This is a SIMPLE working version with the exact
 * signature so the v2 flow builds and runs; the full helper (analytics ids,
 * supersedes, moving drafted lines out of the active cart) replaces it at
 * merge.
 *
 * POSTs the cart to /api/checkout and parses the answer defensively: a
 * network failure, timeout or non-JSON reply becomes a friendly `error`, never
 * a thrown exception. On a real order it records the pending invoice (the
 * "Resume payment" link); the CALLER does window.location.assign(invoiceUrl).
 */

export type CheckoutResult =
  | { ok: true; kind: "redirect"; invoiceUrl: string; draftOrderId: string }
  | { ok: true; kind: "dry-run"; payload: unknown }
  | {
      ok: false;
      status: number;
      error: string;
      lineErrors?: { lineId: string; code: string; message: string }[];
    };

const TIMEOUT_MS = 30_000;

export async function startCheckout(opts: {
  lines: CartLine[];
  discountCodes: string[];
  email?: string | null;
  /** The displayed order total, for begin_checkout's value (display only). */
  valueCents?: number | null;
}): Promise<CheckoutResult> {
  const { lines, discountCodes } = opts;
  const email = opts.email?.trim() || null;
  trackBeginCheckout(opts.valueCents ?? null);

  // The server prices from ids and prints from the uploaded Blob URLs — it
  // never reads a custom line's embedded design document or preview data
  // URL. Null only those two (photo-heavy designs would blow the ~4.5 MB
  // body cap); everything else rides as-is.
  const payloadLines = lines.map((l) =>
    l.graphic.type === "custom"
      ? {
          ...l,
          graphic: { ...l.graphic, design: null, preview: "" } as unknown as CartLine["graphic"],
        }
      : l,
  );

  const fail = (status: number, error: string, lineErrors?: unknown): CheckoutResult => {
    track("checkout_failed", { status, error });
    const le = Array.isArray(lineErrors)
      ? lineErrors
          .filter(
            (x): x is { lineId: string; code: string; message: string } =>
              !!x &&
              typeof x === "object" &&
              typeof (x as Record<string, unknown>).lineId === "string" &&
              typeof (x as Record<string, unknown>).message === "string",
          )
          .map((x) => ({ lineId: x.lineId, code: String(x.code ?? ""), message: x.message }))
      : undefined;
    return { ok: false, status, error, ...(le?.length ? { lineErrors: le } : {}) };
  };

  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    const preview = previewVariantName();
    res = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        lines: payloadLines,
        ...(discountCodes.length ? { discountCodes } : {}),
        ...(email ? { email } : {}),
        // Non-production preview sitting only; the server ignores it in
        // production (its own Host picks the profile there).
        ...(preview ? { previewVariant: preview } : {}),
      }),
      signal: ctrl.signal,
    });
  } catch {
    return fail(
      0,
      ctrl.signal.aborted
        ? "Checkout is taking too long to answer — check your connection and try again."
        : "We couldn't reach checkout — check your connection and try again.",
    );
  } finally {
    window.clearTimeout(timer);
  }

  let data: Record<string, unknown> | null = null;
  try {
    const j = await res.json();
    data = j && typeof j === "object" ? (j as Record<string, unknown>) : null;
  } catch {
    data = null;
  }

  if (!res.ok || !data) {
    const msg =
      typeof data?.error === "string" && data.error
        ? data.error
        : res.status === 429
          ? "Too many checkout attempts — give it a minute and try again."
          : "Checkout hit a snag — please try again in a moment.";
    return fail(res.status, msg, data?.lineErrors);
  }

  if (data.dryRun === true) {
    track("checkout_succeeded", { dry_run: true });
    return { ok: true, kind: "dry-run", payload: data };
  }

  const orders = Array.isArray(data.orders) ? data.orders : [];
  const order = orders[0] as Record<string, unknown> | undefined;
  if (
    orders.length === 1 &&
    typeof order?.invoiceUrl === "string" &&
    typeof order?.draftOrderId === "string"
  ) {
    savePendingOrder({
      invoiceUrl: order.invoiceUrl,
      createdAt: Date.now(),
      draftOrderId: order.draftOrderId,
      lineIds: lines.map((l) => l.id),
    });
    track("checkout_succeeded", { dry_run: false });
    return {
      ok: true,
      kind: "redirect",
      invoiceUrl: order.invoiceUrl,
      draftOrderId: order.draftOrderId,
    };
  }
  return fail(res.status, "Checkout returned something unexpected — please try again.");
}
