"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import type { HubReview } from "@/lib/hub";

/**
 * Thumbnail strip + full-size lightbox for one review's photos/videos.
 * Media URLs come from the hub's own Blob store (already allowed in
 * next.config images). Uses a native <dialog>: top-layer stacking, Esc and
 * focus handling come from the platform instead of hand-rolled traps.
 */
export default function MediaGallery({
  media,
  reviewer,
}: {
  media: HubReview["media"];
  reviewer: string;
}) {
  const items = media.filter(
    (m) => m.url && (m.kind === "photo" || m.kind === "video"),
  );
  // Index of the item shown in the lightbox; null = closed.
  const [idx, setIdx] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const open = idx !== null;

  // The dialog top-layers over the page but doesn't stop it scrolling —
  // lock the body while open so arrow keys / wheel don't move the wall.
  // Cleanup resets to "" (not a saved value): lightboxes are the only body
  // overflow writers here, and restoring a snapshot can re-lock the page if
  // one gallery's close and another's open land in the same task.
  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const show = (i: number) => {
    setIdx(i);
    dialogRef.current?.showModal();
  };
  // ONE close path we own (button, backdrop, Esc): close the element AND
  // reset state, never waiting on the async native close event round-trip.
  // onClose below only syncs state for platform-initiated closes.
  const close = useCallback(() => {
    dialogRef.current?.close();
    setIdx(null);
  }, []);
  const step = useCallback(
    (d: number) =>
      setIdx((cur) =>
        cur === null ? cur : (cur + d + items.length) % items.length,
      ),
    [items.length],
  );

  if (items.length === 0) return null;
  const cur = idx !== null ? items[idx] : undefined;

  return (
    <>
      <div className="review-thumbs">
        {items.map((m, i) => (
          <button
            key={m.url}
            type="button"
            className="review-thumb"
            onClick={() => show(i)}
            aria-label={
              m.kind === "video"
                ? `Play customer video from ${reviewer}`
                : `View customer photo from ${reviewer}`
            }
          >
            {m.kind === "video" ? (
              <>
                {/* #t=0.1 nudges browsers (Safari) to paint a first frame */}
                <video
                  className="review-thumb-media"
                  src={`${m.url}#t=0.1`}
                  preload="metadata"
                  muted
                  playsInline
                />
                <span className="review-thumb-play" aria-hidden="true">
                  ▶
                </span>
              </>
            ) : (
              <Image
                className="review-thumb-media"
                src={m.url}
                alt=""
                width={144}
                height={144}
                sizes="72px"
              />
            )}
          </button>
        ))}
      </div>
      <dialog
        ref={dialogRef}
        className="lightbox"
        aria-label={`Customer photos and videos from ${reviewer}`}
        onClose={() => setIdx(null)}
        // A click that lands on the dialog element itself is the backdrop.
        onClick={(e) => {
          if (e.target === dialogRef.current) close();
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            // preventDefault stops the native cancel from re-closing
            e.preventDefault();
            close();
            return;
          }
          if (items.length < 2) return;
          // A focused <video> uses arrows to seek — don't also flip media.
          if ((e.target as HTMLElement).tagName === "VIDEO") return;
          if (e.key === "ArrowRight") step(1);
          if (e.key === "ArrowLeft") step(-1);
        }}
      >
        {/* Mounted only while open so closed lightboxes load nothing. */}
        {idx !== null && cur && (
          <div className="lb-body">
            <div className="lb-media">
              {cur.kind === "video" ? (
                // key resets playback state when stepping between videos
                <video
                  key={cur.url}
                  className="lb-video"
                  src={cur.url}
                  controls
                  playsInline
                />
              ) : (
                <Image
                  key={cur.url}
                  className="lb-img"
                  src={cur.url}
                  alt={`Customer photo from ${reviewer}`}
                  fill
                  sizes="(max-width: 900px) 92vw, 860px"
                  // mounts only when opened — fetch NOW, not on an
                  // IntersectionObserver tick behind the top layer
                  loading="eager"
                />
              )}
            </div>
            {items.length > 1 && (
              <>
                <button
                  type="button"
                  className="lb-nav prev"
                  onClick={() => step(-1)}
                  aria-label="Previous photo or video"
                >
                  ‹
                </button>
                <button
                  type="button"
                  className="lb-nav next"
                  onClick={() => step(1)}
                  aria-label="Next photo or video"
                >
                  ›
                </button>
              </>
            )}
            <footer className="lb-foot">
              <span>From {reviewer}</span>
              {items.length > 1 && (
                <span>
                  {idx + 1} / {items.length}
                </span>
              )}
            </footer>
            <button
              type="button"
              className="lb-close"
              onClick={close}
              aria-label="Close"
            >
              ×
            </button>
          </div>
        )}
      </dialog>
    </>
  );
}
