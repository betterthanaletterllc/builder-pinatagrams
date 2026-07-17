"use client";

import { useEffect, useState } from "react";
import Image from "next/image";
import builtInLogo from "../../public/pinatagrams-logo.png";

/**
 * Full-screen scrollable landing overlay shown OVER the builder (Nathan's
 * sketch): logo, then alternating line + photo, reading as ONE sentence —
 * "Personalized mini piñatas, / filled with sweets and treats, / carrying a
 * message, / delivered straight to their door." — closing with a single
 * Build-My-Piñata button that dismisses to the body picker underneath.
 * Photos are the hub-managed landing images (admin /pricing → "Landing
 * page"), in order; a section whose photo hasn't been uploaded yet just
 * shows its line. All images go through next/image so the overlay ships
 * ~100 KB of WebP instead of megabytes of PNG.
 *
 * Dismissal is remembered for the SITTING (sessionStorage) so bouncing back
 * to the home page mid-build doesn't replay the pitch; a fresh visit sees it
 * again.
 */

const SEEN_KEY = "pinatagrams-landing-seen";

// One continuous sentence across the stack — lowercase continuations and
// punctuation are deliberate.
const LINES = [
  "Personalized mini piñatas,",
  "filled with sweets and treats,",
  "carrying your personal message,",
  "delivered straight to their door.",
];

export default function LandingOverlay({
  logo,
  images,
}: {
  logo?: string | null;
  images: { id: string; label: string; url: string }[];
}) {
  const [open, setOpen] = useState(true);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(SEEN_KEY)) setOpen(false);
    } catch {}
  }, []);

  // The overlay owns the scroll while it's up.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  const dismiss = () => {
    try {
      sessionStorage.setItem(SEEN_KEY, "1");
    } catch {}
    setOpen(false);
    window.scrollTo({ top: 0 });
  };

  return (
    <div className="landing-overlay" role="dialog" aria-label="Piñatagrams">
      <div className="landing-scroll">
        {logo ? (
          // Hub-managed logo (admin /pricing → "Landing page" → Logo).
          <Image
            className="landing-logo landing-logo-tall"
            src={logo}
            alt="Piñatagrams"
            width={1200}
            height={1200}
            priority
          />
        ) : (
          // Built-in brand logo (wide wordmark) until the hub sets one.
          <Image
            className="landing-logo landing-logo-wide"
            src={builtInLogo}
            alt="Piñatagrams"
            priority
          />
        )}
        {LINES.map((line, i) => (
          <div className="landing-sec" key={line}>
            <p className="landing-line">{line}</p>
            {i < LINES.length - 1 && images[i] && (
              <Image
                className="landing-photo"
                src={images[i].url}
                alt={images[i].label}
                width={1080}
                height={1080}
                sizes="(max-width: 500px) calc(100vw - 40px), 420px"
                priority={i === 0}
              />
            )}
          </div>
        ))}
        <button className="btn primary landing-cta" onClick={dismiss}>
          Build My Piñatagram
        </button>
      </div>
    </div>
  );
}
