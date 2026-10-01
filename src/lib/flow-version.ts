/**
 * Which customer journey a request gets. Since 2026-09-30 every host runs
 * the four-step journey ("v2", everything under src/v2) — it replaced the
 * original flow ("v1") on builder.pinatagrams.com after running on
 * builder2.pinatagrams.com. v1 is sunset: production never serves it, and
 * its code stays only until it's removed, reachable through the preview
 * override below. (Prices and carriers still follow each host's variant
 * profile in the hub, resolved by hostname — lib/variant.)
 *
 * src/middleware.ts stamps the decision on every request as the x-pg-flow
 * header; server components read it back with flowFromHeaders(). Outside
 * production, ?flow=v1|v2 overrides it and is remembered in a cookie, so v1
 * can still be walked on localhost / Vercel previews (and ?variant=<name>
 * previews a hub profile, e.g. version-b). Production ignores both.
 *
 * The flow is PRESENTATION only: checkout re-prices and re-validates every
 * line from the hub either way, and variant identity stays advisory.
 *
 * Edge-safe on purpose (no Node or next/headers imports): the middleware,
 * server components and client code all import this module.
 */

export type FlowVersion = "v1" | "v2";

/** Request header carrying the middleware's decision to server components. */
export const FLOW_HEADER = "x-pg-flow";

/** Non-production preview memory: ?flow= and ?variant= survive navigation. */
export const FLOW_COOKIE = "pg-flow";
export const VARIANT_COOKIE = "pg-variant";

export function parseFlow(v: string | null | undefined): FlowVersion | null {
  return v === "v1" || v === "v2" ? v : null;
}

/** The flow a hostname serves when no preview override applies: v2, on
 *  every host (v1 is sunset). */
export function flowForHost(_host?: string | null): FlowVersion {
  return "v2";
}

/** Preview overrides (?flow=, ?variant= cookies) — the same gate v1 uses for
 *  ?variant=: anything but a production deployment. */
export function previewOverridesAllowed(): boolean {
  return process.env.VERCEL_ENV !== "production";
}

/** Read the request's flow in a server component: the middleware's header,
 *  or — should a request ever bypass the middleware — the hostname itself. */
export function flowFromHeaders(h: {
  get(name: string): string | null;
}): FlowVersion {
  return parseFlow(h.get(FLOW_HEADER)) ?? flowForHost(h.get("host"));
}
