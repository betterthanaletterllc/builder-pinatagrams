import { NextRequest, NextResponse } from "next/server";
import { isMcpMode } from "@/lib/app-mode";

/**
 * MCP server shell — stateless Streamable HTTP. Every POST is one JSON-RPC
 * exchange answered as application/json (no sessions, no SSE stream), the
 * mode claude.ai connectors, Claude Code and ChatGPT all speak today. Ported
 * from the hub's shell (admin/src/lib/mcp-http.ts) with the capability-URL
 * secret removed: this server is PUBLIC by design — payment on Shopify's
 * hosted checkout is the only gate an order needs, and no tool here can move
 * money, stock or data on its own.
 *
 * Compliance notes vs the 2025-06-18 spec: Origin is validated (DNS
 * rebinding guard), tokens are never read from the URL, GET answers 405,
 * and newer clients' MCP-Protocol-Version / Mcp-Method headers are
 * tolerated. A 2026-07-28 modern-only client (no `initialize`) is not
 * served yet; dual-era clients fall back to `initialize` and work.
 */

const PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);
const DEFAULT_PROTOCOL = "2025-06-18";

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
};

export type McpToolListing = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: ToolAnnotations;
};

export type McpServerDef = {
  /** serverInfo.name shown to the client (the user names the connector). */
  name: string;
  version: string;
  /** Server context the client injects for its model — tone + ground rules. */
  instructions: string;
  toolList: () => McpToolListing[];
  /** Runs a tool, returns an MCP CallToolResult. Throws only on unknown tool. */
  execute: (name: string, args: unknown) => Promise<unknown>;
};

/**
 * Browsers only send Origin on cross-site requests; MCP hosts (claude.ai,
 * ChatGPT, Claude Code) call server-to-server with none. A present Origin
 * must be on the allowlist — our own host plus the hosted assistants —
 * which blocks a rebinding page from driving the server from a victim's
 * browser without blocking any real client. MCP_ALLOWED_ORIGINS extends it.
 */
const DEFAULT_ORIGINS = [
  "https://mcp.pinatagrams.com",
  "https://claude.ai",
  "https://claude.com",
  "https://chatgpt.com",
  "https://chat.openai.com",
  "https://platform.openai.com",
];

function originAllowed(req: NextRequest): boolean {
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return !origin;
  const extra = (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...DEFAULT_ORIGINS, ...extra].includes(origin.toLowerCase());
}

function corsHeaders(req: NextRequest): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin || !originAllowed(req)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Accept, Authorization, MCP-Protocol-Version, Mcp-Method, Mcp-Name, Mcp-Session-Id",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function rpcResult(req: NextRequest, id: unknown, result: unknown): NextResponse {
  return NextResponse.json({ jsonrpc: "2.0", id, result }, { headers: corsHeaders(req) });
}

function rpcError(req: NextRequest, id: unknown, code: number, message: string): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { headers: corsHeaders(req) },
  );
}

const NOT_FOUND = () => new NextResponse("Not found", { status: 404 });

export function mcpHandlers(def: McpServerDef) {
  async function POST(req: NextRequest) {
    if (!isMcpMode()) return NOT_FOUND();
    if (!originAllowed(req)) return new NextResponse("Forbidden", { status: 403 });

    let body: { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
    try {
      body = await req.json();
    } catch {
      return rpcError(req, null, -32700, "Parse error");
    }
    const { id, method, params } = body;

    // Notifications carry no id and expect no response.
    if (method?.startsWith("notifications/")) {
      return new NextResponse(null, { status: 202, headers: corsHeaders(req) });
    }

    switch (method) {
      case "initialize": {
        const requested = String(params?.protocolVersion ?? "");
        return rpcResult(req, id, {
          protocolVersion: PROTOCOL_VERSIONS.has(requested) ? requested : DEFAULT_PROTOCOL,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: def.name, version: def.version },
          instructions: def.instructions,
        });
      }
      case "ping":
        return rpcResult(req, id, {});
      case "tools/list":
        return rpcResult(req, id, { tools: def.toolList() });
      case "tools/call": {
        const name = String(params?.name ?? "");
        try {
          return rpcResult(req, id, await def.execute(name, params?.arguments));
        } catch (err) {
          return rpcError(req, id, -32602, err instanceof Error ? err.message : String(err));
        }
      }
      default:
        return rpcError(req, id, -32601, `Method not found: ${method}`);
    }
  }

  // Stateless server: no SSE stream to offer, nothing to delete.
  async function GET() {
    if (!isMcpMode()) return NOT_FOUND();
    return new NextResponse("Method Not Allowed", {
      status: 405,
      headers: { Allow: "POST, OPTIONS, DELETE" },
    });
  }

  async function DELETE() {
    if (!isMcpMode()) return NOT_FOUND();
    return new NextResponse(null, { status: 200 });
  }

  async function OPTIONS(req: NextRequest) {
    if (!isMcpMode()) return NOT_FOUND();
    if (!originAllowed(req)) return new NextResponse("Forbidden", { status: 403 });
    return new NextResponse(null, { status: 204, headers: corsHeaders(req) });
  }

  return { POST, GET, DELETE, OPTIONS };
}

/** Wrap a handler's JSON result as MCP text content. */
export function toolText(result: unknown): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
}

/** Wrap a refusal as an MCP error result (isError, never a thrown exception). */
export function toolError(message: string): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return { content: [{ type: "text", text: message }], isError: true };
}
