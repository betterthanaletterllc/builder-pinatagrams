import { timingSafeEqual } from "node:crypto";
import { toolError, toolText, type McpToolListing } from "@/lib/mcp-http";
import { designTools } from "@/lib/mcp-tools/designs";
import { mockupTools } from "@/lib/mcp-tools/mockup";
import { orderTools, type ToolDef } from "@/lib/order-tools";

/**
 * The STAFF MCP server's registry (mcp.pinatagrams.com/api/mcp/staff/<secret>):
 * tools for the team, never for customers — today render_mockup, plus the
 * two reads it pairs with (list_designs to find codes, get_catalog for the
 * body-style ids). Nothing here writes anything.
 *
 * Kept apart from the public ordering server on purpose: render_mockup
 * fetches any public https image a caller names, which is fine behind a
 * secret and not something to hand the open internet.
 */

export const staffTools: Record<string, ToolDef> = {
  ...mockupTools,
  list_designs: designTools.list_designs,
  get_catalog: orderTools.get_catalog,
};

export function staffToolList(): McpToolListing[] {
  return Object.entries(staffTools).map(([name, def]) => ({
    name,
    ...(def.title ? { title: def.title } : {}),
    description: def.description,
    inputSchema: def.inputSchema,
    annotations: def.annotations,
  }));
}

export async function executeStaffTool(name: string, args: unknown) {
  const def = staffTools[name];
  if (!def) throw new Error(`Unknown tool: ${name}`);
  const input =
    args && typeof args === "object" && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  try {
    const result = await def.handler(input);
    if (result && typeof result === "object" && "content" in result) return result;
    return toolText(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[mcp-staff] ${name} failed: ${message}`);
    return toolError(`${name} failed: ${message}`);
  }
}

/** Shortest MCP_STAFF_SECRET the server accepts (a guessable one = public). */
export const MIN_SECRET_LENGTH = 24;

/**
 * The capability check: the path segment, or an `Authorization: Bearer`
 * header for clients that can send one, must equal MCP_STAFF_SECRET. No
 * secret configured (or one too short) = the staff server does not exist.
 */
export function staffAuthorized(
  pathSecret: string | null,
  authorization: string | null,
  expected: string | undefined = process.env.MCP_STAFF_SECRET,
): boolean {
  const want = expected?.trim();
  if (!want || want.length < MIN_SECRET_LENGTH) return false;
  const same = (got: string | null | undefined) => {
    if (!got) return false;
    const a = Buffer.from(got);
    const b = Buffer.from(want);
    return a.length === b.length && timingSafeEqual(a, b);
  };
  const bearer = authorization?.replace(/^Bearer\s+/i, "").trim() ?? null;
  return same(pathSecret) || same(bearer);
}
