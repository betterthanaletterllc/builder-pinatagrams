import { NextResponse } from "next/server";
import { HUB_URL } from "@/lib/hub";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Same-origin proxy for the cart's discount-code preview. Rate-limited (a
 * public endpoint that confirms whether a code exists would otherwise be
 * brute-forceable) and forwards to the hub server-side, so the code never
 * rides a cross-origin request and the hub URL stays off the client.
 * Returns the rule or null; checkout re-resolves authoritatively.
 */
export async function POST(req: Request) {
  if (!rateLimit(`discount:${clientIp(req)}`, 20, 60_000)) {
    return NextResponse.json(
      { error: "Too many tries — wait a moment." },
      { status: 429 },
    );
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ discount: null });
  }
  const raw = (body as { code?: unknown })?.code;
  const code =
    typeof raw === "string" ? raw.trim().slice(0, 32).toUpperCase() : "";
  if (!code) return NextResponse.json({ discount: null });
  try {
    const res = await fetch(
      `${HUB_URL}/api/public/discount?code=${encodeURIComponent(code)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return NextResponse.json({ discount: null });
    const j = await res.json();
    return NextResponse.json({ discount: j?.discount ?? null });
  } catch {
    return NextResponse.json({ discount: null });
  }
}
