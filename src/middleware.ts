import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * Variant hosts must never be indexed: a search engine finding an A/B arm
 * or niche storefront would keep serving its divergent flow (and prices) to
 * organic traffic long after a test ends — and every new subdomain is
 * public knowledge the hour it gets TLS (certificate-transparency logs).
 * Only the canonical main site stays indexable.
 */
const CANONICAL_HOST = "builder.pinatagrams.com";

export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  const host = (req.headers.get("host") ?? "")
    .toLowerCase()
    .replace(/:\d+$/, "");
  if (process.env.VERCEL_ENV === "production" && host !== CANONICAL_HOST) {
    res.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return res;
}

export const config = {
  // Pages + API only; static assets don't need the header.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|pinatas/).*)"],
};
