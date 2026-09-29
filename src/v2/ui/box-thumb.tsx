import type { LogoZone } from "@/lib/hub";
import type { GraphicChoice } from "@/lib/flow";
import { cdnThumb } from "@/lib/library-data";
import s from "./box-thumb.module.css";

/**
 * "Your box" in miniature: the style's box photo with the graphic placed in
 * its logo zone — the same composite math as the Stage (BoxPreview) and the
 * cart thumbnails, sized by its container. Decorative (alt="") — the row
 * or bar it sits in names the piñata in text.
 */

/** The light preview art for a graphic: custom = its data-URL preview; hub =
 *  the upload-time thumb; library = a CDN-resized copy (never the multi-MB
 *  print file). Same rules as v1's rail. */
export function previewArt(g: GraphicChoice | null, width = 720): string | null {
  if (!g) return null;
  if (g.type === "custom") return g.preview || null;
  if (g.type === "hub") return g.thumb ?? g.art;
  return cdnThumb(g.art ?? g.thumb, width);
}

export default function BoxThumb({
  boxImageUrl,
  logoZone,
  graphic,
  size = 40,
  className,
}: {
  boxImageUrl: string | null;
  logoZone: LogoZone | null;
  graphic: GraphicChoice | null;
  size?: number;
  className?: string;
}) {
  const art = previewArt(graphic, 240);
  return (
    <span
      // a shopper's own design (their photos) is never session-recorded
      className={`${s.thumb} ${graphic?.type === "custom" ? "ph-no-capture" : ""} ${className ?? ""}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {boxImageUrl ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={boxImageUrl} alt="" className={s.box} width={size} height={size} />
          {art && logoZone && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={art}
              alt=""
              className={s.art}
              style={{
                left: `${logoZone.x * 100}%`,
                top: `${logoZone.y * 100}%`,
                width: `${logoZone.w * 100}%`,
                height: `${logoZone.h * 100}%`,
              }}
            />
          )}
        </>
      ) : art ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img src={art} alt="" className={s.box} width={size} height={size} />
      ) : null}
    </span>
  );
}
