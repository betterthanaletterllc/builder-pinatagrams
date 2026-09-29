import { timingSafeEqual } from "node:crypto";
import type { Carrier } from "./delivery";

/**
 * Minimal Shopify Admin GraphQL client for the builder's server routes
 * (checkout, order status, the draft-expiry cron), plus the small PURE
 * draft-order rules those routes share. Auth is the client-credentials grant
 * (the admin.btal Dev Dashboard app). Returns null when creds aren't
 * configured (e.g. local dev), so callers can degrade gracefully instead of
 * erroring.
 */

/**
 * The ONE Admin API version every builder call pins. Shopify supports a
 * stable version for about a year; an unsupported pin silently falls FORWARD
 * to the oldest supported one — untested schema drift on the money path. Bump
 * it deliberately: check every operation against the new schema and push one
 * test order through Paper. 2026-07 is supported until ~July 2027.
 */
export const SHOPIFY_API_VERSION = "2026-07";

/** Hard deadline for any one Shopify round trip — a hung Admin API becomes a
 *  friendly error, not a spinner that outlives the function. */
export const SHOPIFY_TIMEOUT_MS = 10_000;

export type ShopifyCreds = { shop: string; clientId: string; clientSecret: string };

export function shopifyCreds(): ShopifyCreds | null {
  const shop = process.env.SHOPIFY_SHOP;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!shop || !clientId || !clientSecret) return null;
  return { shop, clientId, clientSecret };
}

// Client-credentials tokens live 24h (expires_in 86399). Minting one per
// request put a whole extra round trip in front of every checkout; instead a
// warm instance keeps its token until ~5 minutes before expiry (read from the
// response, never hard-coded). Concurrent requests share one in-flight mint,
// and a 401 (secret rotated, app reinstalled) drops the token and re-mints.
const TOKEN_REFRESH_EARLY_MS = 5 * 60_000;
let tokenCache: { key: string; token: string; scope: string; expiresAt: number } | null = null;
let tokenInflight: { key: string; promise: Promise<string> } | null = null;

async function mintToken(creds: ShopifyCreds, key: string): Promise<string> {
  const res = await fetch(
    `https://${creds.shop}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }),
      signal: AbortSignal.timeout(SHOPIFY_TIMEOUT_MS),
    },
  );
  if (!res.ok) throw new Error(`shopify auth failed: HTTP ${res.status}`);
  const json = (await res.json()) as {
    access_token?: unknown;
    scope?: unknown;
    expires_in?: unknown;
  };
  if (typeof json?.access_token !== "string" || !json.access_token) {
    throw new Error("shopify auth failed: no access_token in the response");
  }
  const ttlSec = Number(json.expires_in);
  const lifeMs = Number.isFinite(ttlSec) && ttlSec > 0 ? ttlSec * 1000 : 60 * 60_000;
  tokenCache = {
    key,
    token: json.access_token,
    scope: typeof json.scope === "string" ? json.scope : "",
    expiresAt: Date.now() + lifeMs - TOKEN_REFRESH_EARLY_MS,
  };
  return json.access_token;
}

/** A valid Admin token, from the instance cache when it has one. `fresh`
 *  discards the cached token first (after a 401). Throws on auth failure. */
export async function shopifyAccessToken(
  creds: ShopifyCreds,
  opts?: { fresh?: boolean },
): Promise<string> {
  const key = `${creds.shop}|${creds.clientId}`;
  if (opts?.fresh && tokenCache?.key === key) tokenCache = null;
  if (tokenCache?.key === key && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  if (tokenInflight?.key === key) return tokenInflight.promise;
  const promise = mintToken(creds, key).finally(() => {
    if (tokenInflight?.promise === promise) tokenInflight = null;
  });
  tokenInflight = { key, promise };
  return promise;
}

/** Scopes the cached token carries (config, not a secret) — for "Access
 *  denied" diagnostics in the function log. */
export function shopifyTokenScope(): string | null {
  return tokenCache?.scope ?? null;
}

export type GqlResponse<T> = {
  status: number;
  data: T | null;
  // Top-level GraphQL errors (schema/permission/throttle), normalized to an
  // array; null when there were none.
  errors: unknown[] | null;
  body: unknown;
};

/**
 * One Admin GraphQL round trip with the cached token, the hard timeout, and a
 * single re-mint on 401 (a request refused as unauthenticated was never
 * processed, so even a mutation is safe to resend). Returns status + parsed
 * body WITHOUT judging it — callers read userErrors themselves. Throws only
 * on transport failure (network, timeout, auth).
 */
export async function shopifyGraphql<T = unknown>(
  creds: ShopifyCreds,
  query: string,
  variables?: Record<string, unknown>,
): Promise<GqlResponse<T>> {
  const url = `https://${creds.shop}.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;
  for (let attempt = 0; ; attempt++) {
    const token = await shopifyAccessToken(creds, { fresh: attempt > 0 });
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": token,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(SHOPIFY_TIMEOUT_MS),
    });
    if (res.status === 401 && attempt === 0) continue;
    const body = (await res.json().catch(() => null)) as {
      data?: T;
      errors?: unknown;
    } | null;
    const errors = body?.errors
      ? Array.isArray(body.errors)
        ? body.errors
        : [body.errors]
      : null;
    return { status: res.status, data: body?.data ?? null, errors, body };
  }
}

export type ShopifyGql = <T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

/** Convenience client for simple reads: resolves `data`, throws on any HTTP
 *  or GraphQL error or an empty body — so a resolved value is always a real
 *  answer (a null field inside it means Shopify said "no such thing"). Null
 *  when creds aren't configured. */
export async function shopifyAdmin(): Promise<ShopifyGql | null> {
  const creds = shopifyCreds();
  if (!creds) return null;
  return async <T>(query: string, variables?: Record<string, unknown>) => {
    const r = await shopifyGraphql<T>(creds, query, variables);
    if (r.status < 200 || r.status >= 300) throw new Error(`shopify gql ${r.status}`);
    if (r.errors) {
      throw new Error(`shopify gql errors: ${JSON.stringify(r.errors)}`);
    }
    if (r.data == null) throw new Error("shopify gql: empty response");
    return r.data;
  };
}

/* ---------------------------------------------------------------------------
 * Builder draft-order rules — PURE (no I/O), shared by checkout and the
 * expire-drafts cron, and unit-testable without a store.
 * ------------------------------------------------------------------------- */

/** Every draft the builder creates carries this tag; automated deletion never
 *  touches a draft without it. */
export const BUILDER_TAG = "builder";
/** Order-level attribute holding the per-draft random nonce: only a client
 *  that was handed the nonce can ask for that draft to be superseded. */
export const NONCE_ATTR = "_builderNonce";

export type Attr = { key: string; value: string | null };

/**
 * Recipient name → MailingAddressInput name fields. A one-word name
 * ("Grandma") rides as lastName ONLY — duplicating it into both fields
 * printed "Grandma Grandma" on the label (Shopify joins first + last). Both
 * fields are optional in the 2026-07 schema.
 */
export function splitRecipientName(name: string): {
  firstName?: string;
  lastName: string;
} {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { lastName: parts[0] ?? "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

/** The gate EVERY automated deletion passes: still unpaid (OPEN or
 *  INVOICE_SENT — never COMPLETED, never one that spawned an order) and
 *  created by the builder. */
export function unpaidBuilderDraft(d: {
  status: string;
  tags: string[];
  order: { id: string } | null;
}): boolean {
  return (
    (d.status === "OPEN" || d.status === "INVOICE_SENT") &&
    !d.order &&
    d.tags.some((t) => t.trim().toLowerCase() === BUILDER_TAG)
  );
}

/** May a checkout that presents `nonce` delete this (older) draft? Only an
 *  unpaid builder draft whose stored nonce matches — so a replayed or guessed
 *  draft id alone can never delete someone's order. */
export function supersedeAllowed(
  d: { status: string; tags: string[]; order: { id: string } | null; customAttributes: Attr[] },
  nonce: string,
): boolean {
  if (!nonce || !unpaidBuilderDraft(d)) return false;
  const stored = d.customAttributes.find((a) => a.key === NONCE_ATTR)?.value ?? "";
  const a = Buffer.from(stored);
  const b = Buffer.from(nonce);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Drafts younger than this are never expired, whatever their date says. */
export const DRAFT_EXPIRY_MIN_AGE_MS = 24 * 60 * 60_000;

export type DraftForExpiry = {
  status: string;
  tags: string[];
  order: { id: string } | null;
  createdAt: string;
  // One attribute list per line item (add-on lines simply carry no date).
  lineAttributes: Attr[][];
};

export type ExpiryDecision =
  | { expire: false; reason: string }
  | {
      expire: true;
      reason: string;
      requestedDate: string;
      carrier: Carrier;
      earliest: string;
    };

/**
 * Should the daily sweep delete this draft? Only an unpaid builder draft at
 * least 24h old whose delivery can no longer be met: some piñata line's
 * `_requestedDate` is before the earliest arrival for an order placed today
 * (`earliestFor` = delivery.ts minDeliveryDate for that line's `_carrier`,
 * FedEx when absent). Paying it would book a date we can't make. A draft
 * with no readable date is KEPT — unknown never deletes.
 */
export function draftExpiry(
  d: DraftForExpiry,
  nowMs: number,
  earliestFor: (carrier: Carrier) => string,
): ExpiryDecision {
  if (!unpaidBuilderDraft(d)) return { expire: false, reason: "not an unpaid builder draft" };
  const created = Date.parse(d.createdAt);
  if (!Number.isFinite(created)) return { expire: false, reason: "unreadable createdAt" };
  if (nowMs - created < DRAFT_EXPIRY_MIN_AGE_MS) {
    return { expire: false, reason: "younger than 24h" };
  }
  let dated = 0;
  let worst: { requestedDate: string; carrier: Carrier; earliest: string } | null = null;
  for (const attrs of d.lineAttributes) {
    const date = attrs.find((a) => a.key === "_requestedDate")?.value ?? "";
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    dated++;
    const carrier: Carrier =
      attrs.find((a) => a.key === "_carrier")?.value === "usps" ? "usps" : "fedex";
    const earliest = earliestFor(carrier);
    if (date < earliest && (!worst || date < worst.requestedDate)) {
      worst = { requestedDate: date, carrier, earliest };
    }
  }
  if (!dated) return { expire: false, reason: "no requested date on any line" };
  if (!worst) return { expire: false, reason: "still deliverable" };
  return { expire: true, reason: "delivery date can no longer be met", ...worst };
}
