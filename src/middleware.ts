import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  FLOW_COOKIE,
  FLOW_HEADER,
  VARIANT_COOKIE,
  flowForHost,
  parseFlow,
  previewOverridesAllowed,
  type FlowVersion,
} from "@/lib/flow-version";

/**
 * Variant hosts must never be indexed: a search engine finding an A/B arm
 * or niche storefront would keep serving its divergent flow (and prices) to
 * organic traffic long after a test ends — and every new subdomain is
 * public knowledge the hour it gets TLS (certificate-transparency logs).
 * Only the canonical main site stays indexable.
 */
const CANONICAL_HOST = "builder.pinatagrams.com";

// Preview cookies only live on localhost / Vercel previews; a week covers a
// test session without leaving a forgotten override around for months.
const PREVIEW_COOKIE = {
  path: "/",
  sameSite: "lax" as const,
  httpOnly: true,
  maxAge: 60 * 60 * 24 * 7,
};

export function middleware(req: NextRequest) {
  const host = (req.headers.get("host") ?? "")
    .toLowerCase()
    .replace(/:\d+$/, "");

  // Which journey this request gets (lib/flow-version): v2 on every host;
  // outside production ?flow=v1|v2 overrides it and is remembered in a
  // cookie so the preview survives navigation (?flow= alone clears it).
  let flow: FlowVersion = flowForHost(host);
  let flowCookie: FlowVersion | null | undefined; // undefined = untouched
  let variantCookie: string | null | undefined;
  if (previewOverridesAllowed()) {
    const q = req.nextUrl.searchParams;
    if (q.has("flow")) {
      flowCookie = parseFlow(q.get("flow"));
      if (flowCookie) flow = flowCookie;
    } else {
      flow = parseFlow(req.cookies.get(FLOW_COOKIE)?.value) ?? flow;
    }
    // ?variant= previews a hub profile by name (v1 reads the param only;
    // v2 pages also read this cookie so the profile sticks across pages).
    if (q.has("variant")) {
      const v = q.get("variant") ?? "";
      variantCookie = /^[a-z0-9-]{1,32}$/.test(v) ? v : null;
    }
  }

  // Hand the decision to server components (layout + pages) as a REQUEST
  // header — always set, never appended, so a client can't smuggle its own.
  const headers = new Headers(req.headers);
  headers.set(FLOW_HEADER, flow);
  const res = NextResponse.next({ request: { headers } });

  if (flowCookie) res.cookies.set(FLOW_COOKIE, flowCookie, PREVIEW_COOKIE);
  else if (flowCookie === null) res.cookies.delete(FLOW_COOKIE);
  if (variantCookie) res.cookies.set(VARIANT_COOKIE, variantCookie, PREVIEW_COOKIE);
  else if (variantCookie === null) res.cookies.delete(VARIANT_COOKIE);

  if (process.env.VERCEL_ENV === "production" && host !== CANONICAL_HOST) {
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return res;
}

export const config = {
  // Pages + API only; static assets don't need the header.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|pinatas/).*)"],
};
