import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mcpHandlers, type McpServerDef } from "./mcp-http";

/**
 * The JSON-RPC shell, driven with synthetic NextRequests in mcp mode
 * (APP_MODE=mcp via vi.stubEnv). Two synthetic server defs: one WITH
 * `resources` (the MCP Apps shape — a tool whose listing carries `_meta`, a
 * ui:// HTML resource) and the same def WITHOUT, which must behave exactly
 * as the shell did before resources existed.
 */

const ENDPOINT = "http://localhost:3016/api/mcp";

type Rpc = {
  jsonrpc: "2.0";
  id: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
};

const TOOL = {
  name: "open_thing",
  title: "Open the thing",
  description: "Opens the thing.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  _meta: { ui: { resourceUri: "ui://x/thing.html" } },
};

const RESOURCE = {
  uri: "ui://x/thing.html",
  name: "Thing",
  description: "The thing's UI",
  mimeType: "text/html;profile=mcp-app",
  _meta: { ui: { csp: { resourceDomains: ["https://cdn.example"], connectDomains: [] }, prefersBorder: true } },
};
const HTML = "<!doctype html><html><body>thing</body></html>";

const plain: McpServerDef = {
  name: "test-server",
  version: "9.9.9",
  instructions: "be nice",
  toolList: () => [TOOL],
  execute: async (name) => ({ content: [{ type: "text", text: `ran ${name}` }] }),
};

const withResources: McpServerDef = {
  ...plain,
  resources: {
    list: () => [RESOURCE],
    read: async (uri) =>
      uri === RESOURCE.uri ? [{ uri, mimeType: RESOURCE.mimeType, text: HTML, _meta: RESOURCE._meta }] : null,
  },
};

function request(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function rpc(def: McpServerDef, method: string, params?: unknown, id: unknown = 1) {
  const res = await mcpHandlers(def).POST(request({ jsonrpc: "2.0", id, method, params }));
  return { status: res.status, headers: res.headers, body: (await res.json()) as Rpc };
}

beforeEach(() => {
  vi.stubEnv("APP_MODE", "mcp");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("mcp-http — initialize", () => {
  it("advertises the resources capability only when the def has resources", async () => {
    const yes = await rpc(withResources, "initialize", { protocolVersion: "2025-06-18" });
    expect(yes.status).toBe(200);
    expect(yes.body.id).toBe(1);
    expect(yes.body.result).toEqual({
      protocolVersion: "2025-06-18",
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: { name: "test-server", version: "9.9.9" },
      instructions: "be nice",
    });

    const no = await rpc(plain, "initialize", { protocolVersion: "2025-06-18" });
    expect(no.body.result?.capabilities).toEqual({ tools: { listChanged: false } });
    expect(no.body.result?.capabilities).not.toHaveProperty("resources");
  });

  it("falls back to the default protocol version for one it doesn't know", async () => {
    const r = await rpc(withResources, "initialize", { protocolVersion: "1999-01-01" });
    expect(r.body.result?.protocolVersion).toBe("2025-06-18");
  });
});

describe("mcp-http — tools/list passthrough", () => {
  it("returns the listing verbatim, title and _meta included", async () => {
    const r = await rpc(withResources, "tools/list", {}, 7);
    expect(r.body.id).toBe(7);
    expect(r.body.result).toEqual({ tools: [TOOL] });
    const tool = (r.body.result?.tools as (typeof TOOL)[])[0];
    expect(tool._meta).toEqual({ ui: { resourceUri: "ui://x/thing.html" } });
    expect(tool.title).toBe("Open the thing");
  });

  it("tools/call hands the arguments to execute and returns its result", async () => {
    const r = await rpc(plain, "tools/call", { name: "open_thing", arguments: { a: 1 } });
    expect(r.body.result).toEqual({ content: [{ type: "text", text: "ran open_thing" }] });
  });
});

describe("mcp-http — resources", () => {
  it("resources/list returns the def's listing", async () => {
    const r = await rpc(withResources, "resources/list", {});
    expect(r.body.result).toEqual({ resources: [RESOURCE] });
  });

  it("resources/read returns the contents for a known uri", async () => {
    const r = await rpc(withResources, "resources/read", { uri: RESOURCE.uri }, "abc");
    expect(r.body.id).toBe("abc");
    expect(r.body.error).toBeUndefined();
    expect(r.body.result).toEqual({
      contents: [{ uri: RESOURCE.uri, mimeType: "text/html;profile=mcp-app", text: HTML, _meta: RESOURCE._meta }],
    });
  });

  it("resources/read of an unknown uri is -32002 Resource not found (HTTP 200, JSON-RPC error)", async () => {
    const r = await rpc(withResources, "resources/read", { uri: "ui://x/nope.html" });
    expect(r.status).toBe(200);
    expect(r.body.result).toBeUndefined();
    expect(r.body.error).toEqual({ code: -32002, message: "Resource not found", data: { uri: "ui://x/nope.html" } });
  });

  it("resources/read without a uri is -32602 Invalid params", async () => {
    const r = await rpc(withResources, "resources/read", {});
    expect(r.body.error?.code).toBe(-32602);
    expect(r.body.error?.message).toMatch(/uri/);
  });

  it("a read that throws is -32603 and never leaks the exception text", async () => {
    const boom: McpServerDef = {
      ...withResources,
      resources: { list: () => [RESOURCE], read: async () => { throw new Error("ENOENT: /secret/path"); } },
    };
    vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await rpc(boom, "resources/read", { uri: RESOURCE.uri });
    expect(r.body.error).toEqual({ code: -32603, message: "Resource unavailable" });
  });

  it("resources/templates/list is an empty list", async () => {
    const r = await rpc(withResources, "resources/templates/list", {});
    expect(r.body.result).toEqual({ resourceTemplates: [] });
  });

  it("a def WITHOUT resources answers every resources/* method with -32601 Method not found", async () => {
    for (const method of ["resources/list", "resources/read", "resources/templates/list"]) {
      const r = await rpc(plain, method, { uri: RESOURCE.uri });
      expect(r.status).toBe(200);
      expect(r.body.result).toBeUndefined();
      expect(r.body.error).toEqual({ code: -32601, message: `Method not found: ${method}` });
    }
  });
});

describe("mcp-http — shell behaviour unchanged", () => {
  it("unknown methods are -32601; notifications are 202 with no body", async () => {
    const r = await rpc(withResources, "frobnicate", {});
    expect(r.body.error?.code).toBe(-32601);

    const res = await mcpHandlers(withResources).POST(
      request({ jsonrpc: "2.0", method: "notifications/initialized" }),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("a malformed body is -32700 Parse error", async () => {
    const res = await mcpHandlers(withResources).POST(request("{not json"));
    const body = (await res.json()) as Rpc;
    expect(body.error).toEqual({ code: -32700, message: "Parse error" });
    expect(body.id).toBeNull();
  });

  it("outside mcp mode every verb is a 404 wall", async () => {
    vi.stubEnv("APP_MODE", "");
    const h = mcpHandlers(withResources);
    expect((await h.POST(request({ jsonrpc: "2.0", id: 1, method: "initialize" }))).status).toBe(404);
    expect((await h.GET()).status).toBe(404);
  });

  it("validates Origin: allowlisted origins get CORS headers, others are 403, none is fine", async () => {
    const h = mcpHandlers(withResources);
    const ok = await h.POST(request({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://claude.ai" }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://claude.ai");
    expect(ok.headers.get("vary")).toBe("Origin");

    const bad = await h.POST(request({ jsonrpc: "2.0", id: 1, method: "ping" }, { origin: "https://evil.example" }));
    expect(bad.status).toBe(403);

    const none = await h.POST(request({ jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(none.status).toBe(200);
    expect(none.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("GET is 405 and OPTIONS preflight is 204 for an allowed origin", async () => {
    const h = mcpHandlers(withResources);
    const get = await h.GET();
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST, OPTIONS, DELETE");
    const pre = await h.OPTIONS(
      new NextRequest(ENDPOINT, { method: "OPTIONS", headers: { origin: "https://mcp.pinatagrams.com" } }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
  });
});
