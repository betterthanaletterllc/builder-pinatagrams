import { NextResponse } from "next/server";
import { ensureOrdersPaidWebhook } from "@/lib/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * Daily: make sure Shopify's orders/paid webhook points at the builder
 * (lib/webhooks — idempotent; creates it only when missing). The same check
 * also runs once per instance after a production checkout, so this cron is
 * the backstop that re-creates it if it's ever removed.
 *
 * Vercel Cron invokes this with `Authorization: Bearer ${CRON_SECRET}`.
 * Fails closed: no secret configured → 503, nothing touched.
 */
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
  const result = await ensureOrdersPaidWebhook();
  if (result.status === "error") console.error("ensure-webhooks:", result.reason);
  return NextResponse.json(result, { status: result.status === "error" ? 502 : 200 });
}
