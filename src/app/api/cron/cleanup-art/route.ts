import { NextResponse } from "next/server";
import { del, list } from "@vercel/blob";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Daily sweep of the transient art staging area. The builder's Blob store
 * only STAGES custom art: Paper snapshots the file into its own GCS the
 * moment an order is paid (order-created webhook), so anything older than
 * the retention window is either long-fulfilled or an abandoned design.
 * 90 days covers the slowest corporate invoice payments; consumers pay in
 * minutes.
 *
 * Vercel Cron invokes this with `Authorization: Bearer ${CRON_SECRET}`
 * when that env var is set. Fails closed: no secret configured → 503 and
 * no deletions, ever.
 */

const RETENTION_DAYS = 90;
const PREFIX = "builder-art/";

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

  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let cursor: string | undefined;
  let scanned = 0;
  let deleted = 0;
  do {
    const page = await list({ prefix: PREFIX, cursor, limit: 1000 });
    scanned += page.blobs.length;
    const old = page.blobs.filter(
      (b) => new Date(b.uploadedAt).getTime() < cutoff,
    );
    if (old.length > 0) {
      await del(old.map((b) => b.url));
      deleted += old.length;
    }
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  console.log(
    `cleanup-art: scanned ${scanned} blobs under ${PREFIX}, deleted ${deleted} older than ${RETENTION_DAYS}d`,
  );
  return NextResponse.json({ scanned, deleted, retentionDays: RETENTION_DAYS });
}
