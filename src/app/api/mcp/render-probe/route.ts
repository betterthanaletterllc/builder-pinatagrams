import { NextResponse } from "next/server";
import { isMcpMode } from "@/lib/app-mode";
import { getCatalog } from "@/lib/hub";
import { clientIp, rateLimit } from "@/lib/rate-limit";
import {
  DEFAULT_MESSAGE,
  LABEL,
  MAX_MESSAGE_CHARS,
  MIN_LABEL_ZONE_PX,
  PROBE_VIEWS,
  RENDERER,
  RenderInputError,
  normalizeMessage,
  renderProbe,
  type ProbeView,
} from "@/lib/render";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/**
 * GET /api/mcp/render-probe — mcp.pinatagrams.com only (404 elsewhere).
 *
 * The Phase 0 risk probe: proves this Vercel project can render print-
 * ready art server-side (resvg + Poppins from files, no system fonts;
 * the hub's WebP box photos via sharp). Public, so it is harmless by
 * construction: read-only, fetches only the hub's own blob store, inputs
 * are a catalog style id, a short Latin message and a view name, output is
 * deterministic for a given catalog, and a per-IP limiter caps the work.
 *
 *   ?style=standard            a bodyStyles[].id from the hub catalog
 *   ?message=Happy+Birthday    ≤ 120 chars; Latin letters/numbers/punctuation
 *   ?view=box | label | open   box (default): the box photo with the label
 *                              composited in its logoZone, label zone ≥ 1200 px
 *                              wide; label: the 2400 × 1170 print file, 300 DPI;
 *                              open: interior + piñata cutout + message card
 *   ?format=json               timings and sizes instead of the PNG
 *
 * After deploy:
 *   curl -o probe.png "https://mcp.pinatagrams.com/api/mcp/render-probe"
 *   curl "https://mcp.pinatagrams.com/api/mcp/render-probe?format=json"
 */

const STYLE_ID = /^[a-z0-9-]{1,32}$/;
const RATE_MAX = 30; // renders per IP per minute on one instance
const RATE_WINDOW_MS = 60_000;

function problem(status: number, message: string) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function GET(req: Request) {
  if (!isMcpMode()) return new NextResponse("Not found", { status: 404 });
  if (!rateLimit(`render-probe:${clientIp(req)}`, RATE_MAX, RATE_WINDOW_MS)) {
    return problem(429, "too many renders; try again in a minute");
  }

  const q = new URL(req.url).searchParams;

  const styleId = q.get("style") ?? "standard";
  if (!STYLE_ID.test(styleId)) return problem(400, "style must be a catalog body-style id");

  const viewArg = q.get("view") ?? "box";
  if (!(PROBE_VIEWS as readonly string[]).includes(viewArg)) {
    return problem(400, `view must be one of: ${PROBE_VIEWS.join(", ")}`);
  }
  const view = viewArg as ProbeView;

  const message = normalizeMessage(q.get("message") ?? DEFAULT_MESSAGE);
  if (!message) return problem(400, `message must be 1–${MAX_MESSAGE_CHARS} printable characters`);

  const format = q.get("format") ?? "png";
  if (format !== "png" && format !== "json") return problem(400, "format must be png or json");

  let catalog;
  try {
    catalog = await getCatalog();
  } catch (err) {
    return problem(502, `hub catalog unavailable: ${err instanceof Error ? err.message : err}`);
  }
  const style = catalog.bodyStyles.find((s) => s.id === styleId);
  if (!style) return problem(404, `no body style "${styleId}" in the catalog`);

  try {
    const out = await renderProbe({ style, box: catalog.box, message, view });
    if (format === "json") {
      return NextResponse.json(
        {
          ok: true,
          view,
          style: style.id,
          message,
          canvas_px: { width: out.width, height: out.height },
          png_bytes: out.png.length,
          render_ms: out.ms,
          ...(out.labelZonePx ? { label_zone_px_wide: out.labelZonePx } : {}),
          label: {
            artboard_px: [LABEL.w, LABEL.h],
            size_in: [LABEL.widthIn, LABEL.heightIn],
            dpi: LABEL.dpi,
            min_zone_px_on_box: MIN_LABEL_ZONE_PX,
          },
          renderer: RENDERER,
          catalog_as_of: catalog.asOf,
        },
        { headers: { "Cache-Control": "no-store" } },
      );
    }
    return new Response(new Uint8Array(out.png), {
      status: 200,
      headers: {
        "Content-Type": "image/png",
        "Content-Length": String(out.png.length),
        "Content-Disposition": `inline; filename="render-probe-${style.id}-${view}.png"`,
        // Deterministic for a given catalog, so the CDN may hold it a while.
        "Cache-Control": "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
        "X-Render-Ms": String(out.ms),
        "X-Render-Canvas": `${out.width}x${out.height}`,
      },
    });
  } catch (err) {
    if (err instanceof RenderInputError) return problem(422, err.message);
    console.error("[render-probe]", err);
    return problem(500, `render failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
