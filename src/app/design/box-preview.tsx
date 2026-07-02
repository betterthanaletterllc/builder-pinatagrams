"use client";

import { useState } from "react";
import type { LogoZone } from "@/lib/hub";

/**
 * The persistent "your box" preview: the customer's choices accumulate on
 * the actual box through the flow.
 *  - closed: the style's box photo with the chosen graphic composited into
 *    its logoZone (plain positioned <img> — same math as the editor).
 *  - open: the message step. Shows the open box (photo at /box-open.jpg,
 *    graceful SVG illustration fallback) with the gift message rendered live
 *    on the INSIDE FLAP — that's physically where it goes.
 * Both layers stay mounted; opacity crossfades between them.
 */

// Printable flap rectangle on the open-box PHOTO (public/box-open.jpg —
// cropped from images/empty_box_open.jpg), as fractions of the image.
// Measured against the flap's flat central area — adjust if the asset changes.
const PHOTO_MESSAGE_ZONE = { x: 0.25, y: 0.795, w: 0.5, h: 0.145 };
// Same rectangle for the SVG fallback illustration below.
const SVG_MESSAGE_ZONE = { x: 0.3, y: 0.78, w: 0.4, h: 0.17 };

function OpenBoxSvg() {
  // Minimal open-box illustration: interior + fold-out flap at the bottom.
  return (
    <svg viewBox="0 0 600 500" className="box-img" aria-hidden>
      <rect width="600" height="500" fill="#f6f2ee" />
      {/* interior back wall */}
      <rect x="170" y="30" width="260" height="330" fill="#ffffff" stroke="#d8d2c8" />
      <rect x="150" y="14" width="300" height="20" fill="#efeae2" stroke="#d8d2c8" />
      <rect x="150" y="14" width="22" height="360" fill="#f3eee6" stroke="#d8d2c8" />
      <rect x="428" y="14" width="22" height="360" fill="#f3eee6" stroke="#d8d2c8" />
      {/* fold-out lid / inside flap */}
      <polygon
        points="150,376 450,376 492,478 108,478"
        fill="#ffffff"
        stroke="#d8d2c8"
      />
      <line x1="150" y1="376" x2="450" y2="376" stroke="#c9c2b6" strokeDasharray="6 5" />
    </svg>
  );
}

export default function BoxPreview({
  styleName,
  boxImageUrl,
  logoZone,
  artUrl,
  message,
  filling,
  deliveryDate,
  mode,
}: {
  styleName: string;
  boxImageUrl: string | null;
  logoZone: LogoZone | null;
  artUrl: string | null;
  message: string;
  filling: string | null;
  deliveryDate: string | null;
  mode: "closed" | "open";
}) {
  const [photoFailed, setPhotoFailed] = useState(false);
  const zone = photoFailed ? SVG_MESSAGE_ZONE : PHOTO_MESSAGE_ZONE;

  // Shrink long messages so they stay on the flap.
  const msgSize =
    message.length > 180 ? 9 : message.length > 90 ? 11 : message.length > 40 ? 13 : 15;

  return (
    <div className="box-preview">
      <div className="box-stage">
        {/* closed box + graphic */}
        <div className={"box-layer" + (mode === "closed" ? " visible" : "")}>
          {boxImageUrl ? (
            <div className="box-composite">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={boxImageUrl} alt={`${styleName} box`} className="box-img" />
              {artUrl && logoZone && (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  src={artUrl}
                  alt="your graphic"
                  className="box-art"
                  style={{
                    left: `${logoZone.x * 100}%`,
                    top: `${logoZone.y * 100}%`,
                    width: `${logoZone.w * 100}%`,
                    height: `${logoZone.h * 100}%`,
                  }}
                />
              )}
            </div>
          ) : (
            <div className="box-composite">
              {artUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img src={artUrl} alt="your graphic" className="box-img" />
              ) : (
                <p className="note">Pick a graphic to see it on the box.</p>
              )}
            </div>
          )}
        </div>

        {/* open box + message on the inside flap */}
        <div className={"box-layer" + (mode === "open" ? " visible" : "")}>
          <div className="box-composite">
            {photoFailed ? (
              <OpenBoxSvg />
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src="/box-open.jpg"
                alt="open box"
                className="box-img"
                onError={() => setPhotoFailed(true)}
              />
            )}
            <div
              className="flap-message"
              style={{
                left: `${zone.x * 100}%`,
                top: `${zone.y * 100}%`,
                width: `${zone.w * 100}%`,
                height: `${zone.h * 100}%`,
                fontSize: msgSize,
              }}
            >
              {message || "Your message appears here, printed on the inside flap."}
            </div>
          </div>
        </div>
      </div>

      <div className="box-meta">
        <strong>{styleName} piñata</strong>
        {mode === "open" && (
          <p className="note">
            Your message is printed right here — on the flap they see the
            moment the box opens.
          </p>
        )}
        {filling && <p className="note">Filled with {filling}</p>}
        {deliveryDate && <p className="note">Arriving {deliveryDate}</p>}
      </div>
    </div>
  );
}
