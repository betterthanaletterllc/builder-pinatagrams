/**
 * Which face of the builder this deployment serves. One codebase, two Vercel
 * projects: builder.pinatagrams.com (the storefront; APP_MODE unset) and
 * mcp.pinatagrams.com (the agent-facing ordering MCP; APP_MODE=mcp). The
 * flag is read at request time, and the MCP project is a separate Vercel
 * project with its own Shopify app, so agent traffic can never throttle or
 * take down the storefront's checkout.
 *
 * In mcp mode the middleware 404s every path except the MCP endpoint; in
 * storefront mode the MCP endpoint 404s. Neither face ever serves the other.
 */
export type AppMode = "storefront" | "mcp";

export function appMode(): AppMode {
  return process.env.APP_MODE === "mcp" ? "mcp" : "storefront";
}

export function isMcpMode(): boolean {
  return appMode() === "mcp";
}

/** Paths the mcp face serves; everything else is a 404 wall. */
export function mcpModeAllows(pathname: string): boolean {
  return (
    pathname === "/api/mcp" ||
    pathname.startsWith("/api/mcp/") ||
    pathname.startsWith("/.well-known/")
  );
}

/**
 * vercel.json's crons fire on EVERY project built from this repo, so the
 * mcp face receives the storefront's cron hits too (art cleanup, draft
 * expiry, webhook registration). None of them may run here — the webhook
 * one would register the storefront's orders/paid hook under the MCP's own
 * Shopify app pointing at a 404 — so they are acknowledged with a no-op
 * 200 instead of a 404, which Vercel would log as a failed cron run.
 */
export function mcpModeSkipsCron(pathname: string): boolean {
  return pathname.startsWith("/api/cron/");
}
