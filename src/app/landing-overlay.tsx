"use client";

import { useEffect, useState } from "react";

/**
 * Full-screen scrollable landing overlay shown OVER the builder (Nathan's
 * sketch): logo, then alternating line + photo — "Personalized mini piñatas"
 * / "Filled with sweets and treats" / "Carrying a message" — closing with
 * "Delivered straight to their door" and one Build-my-Piñata button that
 * dismisses to the body picker underneath. Photos are the hub-managed
 * landing images (admin /pricing → "Landing page"), in order; a section
 * whose photo hasn't been uploaded yet just shows its line.
 *
 * Dismissal is remembered for the SITTING (sessionStorage) so bouncing back
 * to the home page mid-build doesn't replay the pitch; a fresh visit sees it
 * again.
 */

const SEEN_KEY = "pinatagrams-landing-seen";

const LINES = [
  "Personalized mini piñatas",
  "Filled with sweets and treats",
  "Carrying a message",
  "Delivered straight to their door",
];

export default function LandingOverlay({
  images,
}: {
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
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img className="landing-logo" src="/pinatagrams-logo.png" alt="Piñatagrams" />
        {LINES.map((line, i) => (
          <div className="landing-sec" key={line}>
            <p className="landing-line">{line}</p>
            {i < LINES.length - 1 && images[i] && (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                className="landing-photo"
                src={images[i].url}
                alt={images[i].label}
                loading={i === 0 ? "eager" : "lazy"}
              />
            )}
          </div>
        ))}
        <button className="btn primary landing-cta" onClick={dismiss}>
          Build my Piñata
        </button>
      </div>
    </div>
  );
}
