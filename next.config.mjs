/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    // Body-style art is served from the hub's public Vercel Blob store.
    remotePatterns: [
      { protocol: "https", hostname: "*.public.blob.vercel-storage.com" },
    ],
  },
};
export default nextConfig;
