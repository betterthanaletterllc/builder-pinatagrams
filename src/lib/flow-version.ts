/**
 * Which customer journey a request gets. builder.pinatagrams.com keeps the
 * original flow ("v1"); builder2.pinatagrams.com runs the four-step journey
 * ("v2", everything under src/v2). ONE codebase, ONE deployment: the request
 * HOSTNAME picks the flow, exactly as it picks the variant profile
 * (lib/variant) — builder2 also resolves to the version-b profile in the hub.
 *
 * src/middleware.ts stamps the decision on every request as the x-pg-flow
 * header; server components read it back with flowFromHeaders(). Outside
 * production, ?flow=v1|v2 overrides the host and is remembered in a cookie
 * so the v2 journey can be walked on localhost / Vercel previews (combine
 * with ?variant=version-b for the builder2 profile). Production ignores both.
 *
 * The flow is PRESENTATION only: checkout re-prices and re-validates every
 * line from the hub either way, and variant identity stays advisory.
 *
 * Edge-safe on purpose (no Node or next/headers imports): the middleware,
 * server components and client code all import this module.
 */

export type FlowVersion = "v1" | "v2";

/** Hostnames that serve the v2 journey in production. */
export const V2_HOSTS = ["builder2.pinatagrams.com"];

/** Request header carrying the middleware's decision to server components. */
export const FLOW_HEADER = "x-pg-flow";

/** Non-production preview memory: ?flow= and ?variant= survive navigation. */
export const FLOW_COOKIE = "pg-flow";
export const VARIANT_COOKIE = "pg-variant";

function hostOnly(host: string | null | undefined): string {
  return (host ?? "").trim().toLowerCase().replace(/:\d+$/, "");
}

export function parseFlow(v: string | null | undefined): FlowVersion | null {
  return v === "v1" || v === "v2" ? v : null;
}

/** The flow a hostname serves when no preview override applies. */
export function flowForHost(host: string | null | undefined): FlowVersion {
  return V2_HOSTS.includes(hostOnly(host)) ? "v2" : "v1";
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
