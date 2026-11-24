import { NextResponse, type NextRequest } from "next/server";
import { mcpHandlers } from "@/lib/mcp-http";
import { executeStaffTool, staffAuthorized, staffToolList } from "@/lib/staff-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A full line-up (~20 styles, closed + open) renders ~40 scenes.
export const maxDuration = 60;

/**
 * The STAFF MCP server — mcp.pinatagrams.com only (APP_MODE=mcp; 404 on the
 * storefront like every /api/mcp path). Tools in src/lib/staff-tools.ts.
 *
 * Auth: capability URL. The [secret] path segment (or an Authorization
 * bearer, for clients that can send headers) must equal MCP_STAFF_SECRET
 * (≥ 24 chars); anything else is a plain 404, so the endpoint's existence
 * isn't advertised. This is the one MCP path here that carries a token in
 * the URL — deliberately, because ChatGPT's and claude.ai's connector
 * forms take a URL and no header. Rotate by changing the env var.
 *
 * Connector URL: https://mcp.pinatagrams.com/api/mcp/staff/<MCP_STAFF_SECRET>
 */

const INSTRUCTIONS = `Piñatagrams staff tools — for the team designing and merchandising piñata gift boxes, not for customers.

render_mockup draws a front graphic and an inside-flap card on the body styles (closed box and/or open box) and returns image(s): ALWAYS show the returned images to the user. Front and flap are each a design code, an https image URL, or none; flap defaults to the front design's own card. To compare ideas, call it once per variation and say what changed between them. Use list_designs to find design codes and get_catalog for body-style ids. Nothing here saves, prices or orders anything; the recipient keeps the piñata (never say "smash" or "break").`;

const server = mcpHandlers({
  name: "pinatagrams-staff",
  version: "0.1.0",
  instructions: INSTRUCTIONS,
  toolList: staffToolList,
  execute: executeStaffTool,
});

type Ctx = { params: Promise<{ secret: string }> };

const notFound = () => new NextResponse("Not found", { status: 404 });

async function gate(req: NextRequest, ctx: Ctx): Promise<boolean> {
  const { secret } = await ctx.params;
  return staffAuthorized(secret ?? null, req.headers.get("authorization"));
}

export async function POST(req: NextRequest, ctx: Ctx) {
  return (await gate(req, ctx)) ? server.POST(req) : notFound();
}
export async function GET(req: NextRequest, ctx: Ctx) {
  return (await gate(req, ctx)) ? server.GET() : notFound();
}
export async function DELETE(req: NextRequest, ctx: Ctx) {
  return (await gate(req, ctx)) ? server.DELETE() : notFound();
}
export async function OPTIONS(req: NextRequest, ctx: Ctx) {
  // Preflights carry no Authorization header; the path secret still applies.
  return (await gate(req, ctx)) ? server.OPTIONS(req) : notFound();
}
