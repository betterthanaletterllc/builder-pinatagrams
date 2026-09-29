"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import builtInLogo from "../../public/pinatagrams-logo.png";
import { track } from "@/lib/analytics";
import PromiseLine, { type PromiseInfo } from "./promise-line";

/**
 * Full-screen scrollable landing overlay shown OVER the builder (Nathan's
 * sketch): logo, then alternating line + photo, reading as ONE sentence —
 * "Personalized mini piñatas, / filled with sweets and treats, / carrying a
 * message, / delivered straight to their door." — closing with a single
 * "Send a Piñatagram" button that dismisses to the body picker underneath.
 * Photos are the hub-managed landing images (admin /pricing → "Landing
 * page"), in order; a section whose photo hasn't been uploaded yet just
 * shows its line. All images go through next/image so the overlay ships
 * ~100 KB of WebP instead of megabytes of PNG.
 *
 * The promise (arrival date · delivered price · rating) sits on the FIRST
 * screen, under the logo. On phones the button rides a sticky bar — it used
 * to sit ~1,500px down an 844px screen.
 *
 * A real modal dialog: focus moves in when it opens, Tab stays inside,
 * Escape closes it, and focus returns to the page when it's dismissed.
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

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function LandingOverlay({
  logo,
  images,
  lines,
  trust,
  promise,
}: {
  logo?: string | null;
  images: { id: string; label: string; url: string }[];
  // Variant override (hub "Builder variants" → landing lines); null = the
  // standard pitch.
  lines?: string[] | null;
  // Aggregate from the hub reviews API; null (fetch failed) = no trust row.
  // Ratings are brand-pooled — the scope label always renders WITH the
  // number, per the API's display contract.
  trust?: { rating: number; count: number; label: string } | null;
  // Arrival · delivered price · rating for the first screen (parts that
  // didn't load are omitted by PromiseLine itself).
  promise?: PromiseInfo | null;
}) {
  const [open, setOpen] = useState(true);
  // False until the "already seen this sitting?" check ran — focus is only
  // moved into a dialog that's actually staying open.
  const [checked, setChecked] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pitchLines = lines && lines.length ? lines : LINES;

  // The CTA, any pitch photo, and Escape all dismiss to the body picker
  // underneath; `via` keeps them apart in the funnel.
  const dismiss = (via: "cta" | "photo" | "escape" = "cta") => {
    track("landing_overlay_dismissed", { via });
    try {
      sessionStorage.setItem(SEEN_KEY, "1");
    } catch {}
    setOpen(false);
    window.scrollTo({ top: 0 });
  };

  useEffect(() => {
    try {
      if (sessionStorage.getItem(SEEN_KEY)) setOpen(false);
    } catch {}
    setChecked(true);
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

  // Modal focus: in on open, trapped inside, back to the page on close.
  useEffect(() => {
    if (!open || !checked) return;
    const before = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        dismiss("escape");
        return;
      }
      if (e.key !== "Tab" || !dialogRef.current) return;
      const items = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(FOCUSABLE),
      );
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      if (e.shiftKey && (at === first || at === dialogRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && at === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Back to where the page was — or, on a first visit (nothing had
      // focus yet), the page's heading right under the overlay.
      const target =
        before && before !== document.body && document.contains(before)
          ? before
          : document.getElementById("home-title");
      target?.focus({ preventScroll: true });
    };
    // dismiss only sets state + storage — any render's copy will do
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, checked]);

  if (!open) return null;

  return (
    <div
      ref={dialogRef}
      className="landing-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Piñatagrams"
      tabIndex={-1}
    >
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
        {promise && <PromiseLine info={promise} className="landing-promise" />}
        {pitchLines.map((line, i) => (
          <div className="landing-sec" key={line}>
            <p className="landing-line">{line}</p>
            {i < pitchLines.length - 1 && images[i] && (
              // Tapping the photo is a shortcut into the builder — same as
              // the CTA. Button (not the bare img) for keyboard + a11y.
              <button
                type="button"
                className="landing-photo-btn"
                onClick={() => dismiss("photo")}
                aria-label="Start building — pick a body style"
              >
                <Image
                  className="landing-photo"
                  src={images[i].url}
                  alt={images[i].label}
                  width={1080}
                  height={1080}
                  sizes="(max-width: 500px) calc(100vw - 40px), 420px"
                  priority={i === 0}
                />
              </button>
            )}
          </div>
        ))}
        {trust && (
          // Compact trust row between the pitch and the CTA: stars, the
          // pooled aggregate, and its scope label as one visual unit.
          <p className="landing-trust">
            <span className="stars" aria-hidden="true">
              <span className="stars-bg">★★★★★</span>
              <span
                className="stars-fill"
                style={{
                  width: `${Math.max(0, Math.min(5, trust.rating)) * 20}%`,
                }}
              >
                ★★★★★
              </span>
            </span>
            <span className="landing-trust-num">
              {trust.rating.toFixed(1)} ·{" "}
              {trust.count.toLocaleString("en-US")} reviews
            </span>
            <span className="landing-trust-scope">{trust.label}</span>
          </p>
        )}
        {/* sticky on phones — always one thumb away */}
        <div className="landing-cta-bar">
          <button
            type="button"
            className="btn primary landing-cta"
            onClick={() => dismiss("cta")}
          >
            Send a Piñatagram
          </button>
        </div>
      </div>
    </div>
  );
}
