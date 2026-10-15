import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Fonts for server-side art. Vercel's Node runtime ships NO system fonts
 * and no fontconfig, so every face the renderer may use is a file in this
 * repo (src/assets/fonts — Poppins, the brand body font, SIL OFL; licence
 * beside the files) and is handed to resvg by PATH.
 *
 * Paths, not buffers: resvg-js re-parses `fontBuffers` on every instance
 * (~200 ms each, measured 2026-10-15) while `fontFiles` are read once and
 * cost ~3 ms per instance. Each path is ONE static expression on
 * process.cwd() so @vercel/nft can trace the file into the function
 * bundle; next.config's outputFileTracingIncludes names the folder as
 * well, so a tracing miss can't silently drop the fonts.
 */
export const FONT_FAMILY = "Poppins";

export type FontWeight = 400 | 600;

export const FONT_FILES: readonly string[] = [
  path.join(process.cwd(), "src/assets/fonts/poppins.regular.ttf"),
  path.join(process.cwd(), "src/assets/fonts/poppins.semibold.ttf"),
];

let verified = false;

/**
 * A missing font file must be a loud error, never a silent fallback: with
 * no system fonts resvg would otherwise draw nothing (or a wrong face) and
 * the "print-ready" PNG would be quietly wrong. Checked once per instance.
 */
export function assertFontsPresent(): void {
  if (verified) return;
  const missing = FONT_FILES.filter((f) => !existsSync(f));
  if (missing.length) {
    throw new Error(
      `render: font file(s) missing from the bundle: ${missing.join(", ")}`,
    );
  }
  verified = true;
}

/** resvg-js font options: our files only, Poppins for every generic family
 *  so an unknown family name can never reach a Times-like fallback. */
export function fontOptions() {
  assertFontsPresent();
  return {
    loadSystemFonts: false,
    fontFiles: [...FONT_FILES],
    defaultFontFamily: FONT_FAMILY,
    sansSerifFamily: FONT_FAMILY,
    serifFamily: FONT_FAMILY,
    monospaceFamily: FONT_FAMILY,
    cursiveFamily: FONT_FAMILY,
    fantasyFamily: FONT_FAMILY,
  };
}
