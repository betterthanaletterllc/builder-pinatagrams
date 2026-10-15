/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // Body-style art is served from the hub's public Vercel Blob store.
    remotePatterns: [
      { protocol: "https", hostname: "*.public.blob.vercel-storage.com" },
    ],
  },
  // The server-side art renderer (src/lib/render) is a native addon with
  // per-platform packages; it must be required at runtime, not bundled.
  serverExternalPackages: ["@resvg/resvg-js"],
  // Its fonts are plain files read with fs — make sure they ride along in
  // the render-probe function bundle even if static tracing misses them.
  outputFileTracingIncludes: {
    "/api/mcp/render-probe": ["./src/assets/fonts/**/*"],
    // The designer MCP App (src/lib/mcp-tools/designer.ts) is one HTML file
    // read with fs at request time; it must ship in the MCP function bundle.
    "/api/mcp": ["./src/mcp-app/**/*"],
  },
};
export default nextConfig;
