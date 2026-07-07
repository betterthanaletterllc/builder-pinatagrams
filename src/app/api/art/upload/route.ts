import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { clientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";

/**
 * Token endpoint for CLIENT-DIRECT Blob uploads of finished designs (the
 * flattened print PNG + its DesignDocument JSON sidecar). Uploading straight
 * from the browser to Blob keeps multi-MB art out of serverless request
 * bodies (Vercel caps those at ~4.5 MB). The resulting public https URL is
 * what rides on the draft order as _frontGraphic — exactly what Paper prints.
 */
export async function POST(request: Request) {
  // Each design save = 2 uploads; 30/min per IP is generous for humans and
  // a wall for upload floods into the Blob store.
  if (!rateLimit(`upload:${clientIp(request)}`, 30, 60_000)) {
    return NextResponse.json(
      { error: "Too many uploads — give it a minute and try again." },
      { status: 429 },
    );
  }

  const body = (await request.json()) as HandleUploadBody;
  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname) => {
        if (!pathname.startsWith("builder-art/")) {
          throw new Error("Uploads must live under builder-art/.");
        }
        return {
          // jpeg: photo designs print-compress ~8× smaller than PNG, which
          // is most of the "saving your design" wait
          allowedContentTypes: ["image/png", "image/jpeg", "application/json"],
          maximumSizeInBytes: 12 * 1024 * 1024,
          addRandomSuffix: false,
        };
      },
      // Runs only on deployed environments (Blob can't call back to
      // localhost) — nothing depends on it.
      onUploadCompleted: async () => {},
    });
    return NextResponse.json(jsonResponse);
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Upload rejected." },
      { status: 400 },
    );
  }
}
