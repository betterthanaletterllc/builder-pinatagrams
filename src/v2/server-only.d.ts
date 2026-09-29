// Next.js resolves "server-only" to its own compiled marker at build time
// (a client import becomes a build error); this tells TypeScript it exists.
declare module "server-only";
