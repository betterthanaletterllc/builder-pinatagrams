"use client";

import { useLayoutEffect, useRef, useState } from "react";
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
// Where the piñata cutout sits inside the open box (bottom-anchored so it
// looks nestled against the box floor, just above the flap fold).
const PHOTO_PINATA_ZONE = { x: 0.22, y: 0.2, w: 0.56, h: 0.47 };
const SVG_PINATA_ZONE = { x: 0.3, y: 0.28, w: 0.4, h: 0.4 };

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
  variant = "full",
  interiorUrl,
  messageZone,
  messageCard,
  messagePadding,
  pinataSrc,
  pinataFallback,
  pinataZone: pinataZoneProp,
}: {
  styleName: string;
  boxImageUrl: string | null;
  logoZone: LogoZone | null;
  artUrl: string | null;
  message: string;
  filling: string | null;
  deliveryDate: string | null;
  mode: "closed" | "open";
  // "bare" hides the meta block (style name, filling, arrival) — used on the
  // message step where the box + text field should be the whole page.
  variant?: "full" | "bare";
  // Hub-configured interior photo + zone (admin /catalog); local fallbacks
  // keep the preview working when the hub hasn't been configured yet.
  interiorUrl?: string | null;
  messageZone?: LogoZone | null;
  // The design's matching inside-flap card (graphics/message) — rendered
  // UNDER the message text so the preview matches what Paper prints.
  // Absent → the interior photo's blank card shows through as before.
  messageCard?: string | null;
  // Hub-tunable padding (admin /catalog) keeping the text inside the card's
  // border art, as percent of the card. Absent → the CSS default (12/7).
  messagePadding?: { x: number; y: number } | null;
  // The chosen piñata, nestled inside the open box: transparent cutout first
  // (/pinatas/{id}.png), the hub catalog image as fallback. The zone comes
  // from the hub (admin "Box placement" per style) with a built-in default.
  pinataSrc?: string | null;
  pinataFallback?: string | null;
  pinataZone?: LogoZone | null;
}) {
  const [photoFailed, setPhotoFailed] = useState(false);
  // 0 = cutout, 1 = hub image fallback, 2 = give up
  const [pinataAttempt, setPinataAttempt] = useState(0);
  const zone =
    (!photoFailed ? messageZone : null) ??
    (photoFailed ? SVG_MESSAGE_ZONE : PHOTO_MESSAGE_ZONE);
  const interiorSrc = (!photoFailed && interiorUrl) || "/box-open.jpg";
  const pinataZone =
    (!photoFailed ? pinataZoneProp : null) ??
    (photoFailed ? SVG_PINATA_ZONE : PHOTO_PINATA_ZONE);
  const pinataImg =
    pinataAttempt === 0 ? pinataSrc : pinataAttempt === 1 ? pinataFallback : null;

  // Auto-fit: shrink the text until the whole message sits inside the white
  // card (padding included). Runs after layout; opacity-hidden layers still
  // have geometry, so this works even before the crossfade reveals it.
  const msgRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = msgRef.current;
    if (!el) return;
    const fit = () => {
      let size = 16;
      el.style.fontSize = `${size}px`;
      while (size > 6 && el.scrollHeight > el.clientHeight) {
        size -= 0.5;
        el.style.fontSize = `${size}px`;
      }
    };
    fit();
    // re-fit when the zone's rendered size changes (rotation, window resize)
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [message, mode, zone.w, zone.h, messagePadding?.x, messagePadding?.y]);

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
              {!artUrl && logoZone && (
                <div
                  className="box-art-placeholder"
                  style={{
                    left: `${logoZone.x * 100}%`,
                    top: `${logoZone.y * 100}%`,
                    width: `${logoZone.w * 100}%`,
                    height: `${logoZone.h * 100}%`,
                  }}
                >
                  Graphic here
                </div>
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
                src={interiorSrc}
                alt="open box"
                className="box-img"
                onError={() => setPhotoFailed(true)}
              />
            )}
            {pinataImg && (
              /* Width + bottom-edge anchored; height follows the image's own
                 aspect — so scaling the zone directly scales the piñata with
                 no dead air above it. zone.h only records the footprint. */
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={pinataImg}
                alt="your piñata, in the box"
                className="box-pinata"
                onError={() => setPinataAttempt((a) => a + 1)}
                style={{
                  left: `${pinataZone.x * 100}%`,
                  bottom: `${(1 - (pinataZone.y + pinataZone.h)) * 100}%`,
                  width: `${pinataZone.w * 100}%`,
                }}
              />
            )}
            {messageCard && !photoFailed && (
              // The matching card sits in the flap zone, text painted on top.
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={messageCard}
                alt=""
                className="flap-card"
                style={{
                  left: `${zone.x * 100}%`,
                  top: `${zone.y * 100}%`,
                  width: `${zone.w * 100}%`,
                  height: `${zone.h * 100}%`,
                }}
              />
            )}
            <div
              ref={msgRef}
              className={
                "flap-message" +
                (messageCard && !photoFailed ? " on-card" : "")
              }
              style={{
                left: `${zone.x * 100}%`,
                top: `${zone.y * 100}%`,
                width: `${zone.w * 100}%`,
                height: `${zone.h * 100}%`,
                ...(messageCard && !photoFailed && messagePadding
                  ? { padding: `${messagePadding.y}% ${messagePadding.x}%` }
                  : null),
              }}
            >
              {message || "Your message appears here, printed on the inside flap."}
            </div>
          </div>
        </div>
      </div>

      {variant === "full" && (
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
      )}
    </div>
  );
}
