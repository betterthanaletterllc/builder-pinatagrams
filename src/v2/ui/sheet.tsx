"use client";

import { useEffect, useId, useRef, type ReactNode } from "react";
import { Close } from "./icons";
import s from "./sheet.module.css";

// iOS doesn't focus a button when it's tapped, so "what opened the sheet"
// is the last thing pressed — focus goes back there when the sheet closes
// (VoiceOver users keep their place instead of landing at the top).
let lastPressed: HTMLElement | null = null;
if (typeof document !== "undefined") {
  document.addEventListener(
    "pointerdown",
    (e) => {
      const t = (e.target as Element | null)?.closest?.("button, a, [role='button'], label");
      if (t instanceof HTMLElement) lastPressed = t;
    },
    { capture: true, passive: true },
  );
}

/**
 * Sheet = a native <dialog> opened with showModal(): the browser supplies
 * the focus trap, Esc-to-close, inertness of the page behind and the top
 * layer. Under 768px it slides up from the bottom edge — `full` sheets
 * (browsing a set of options) take the whole screen; above 768px it's a
 * centered panel. Callers keep ONE sheet state for the whole flow, so sheets
 * never stack.
 *
 * Children mount only while open — the library and editor chunks load on
 * intent, never with the page.
 */
export default function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  wide = false,
  full = false,
  tall = false,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  full?: boolean;
  /** At least ~60% of a phone's height, content centred (the zoom). */
  tall?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  // Only a press that STARTS and ENDS on the backdrop closes the sheet — a
  // text selection dragged out of the panel must not.
  const downOnBackdrop = useRef(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    const d = ref.current;
    if (!d || !open) return;
    const active = document.activeElement;
    const opener =
      active instanceof HTMLElement && active !== document.body ? active : lastPressed;
    if (!d.open) d.showModal();
    // Keep the page behind from scrolling under a finger on the backdrop.
    const root = document.documentElement;
    const prevOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    // A full-screen sheet looks like a page, so the phone's Back (the iOS
    // edge swipe, which has no close-watcher) must close it — not leave the
    // step or the site. It gets its own history entry (same URL); Back pops
    // it, and any other way of closing takes the entry back off.
    // Each opening gets its own token: an old sheet entry left as a Forward
    // entry must never pass for this one.
    let entry: string | null = null;
    const onPop = () => {
      if (entry && window.history.state?.pgSheet !== entry) {
        entry = null;
        onCloseRef.current();
      }
    };
    if (full) {
      entry = Math.random().toString(36).slice(2);
      window.history.pushState({ ...window.history.state, pgSheet: entry }, "");
      window.addEventListener("popstate", onPop);
    }
    return () => {
      window.removeEventListener("popstate", onPop);
      if (entry && window.history.state?.pgSheet === entry) window.history.back();
      root.style.overflow = prevOverflow;
      if (d.open) d.close();
      opener?.focus({ preventScroll: true });
    };
  }, [open, full]);

  return (
    <dialog
      ref={ref}
      className={`${s.sheet}${wide ? ` ${s.wide}` : ""}${full ? ` ${s.full}` : ""}${tall ? ` ${s.tall}` : ""}`}
      aria-labelledby={titleId}
      // Esc (native cancel → close) and backdrop taps report back up so the
      // caller's state stays the single source of truth.
      onClose={() => onCloseRef.current()}
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (downOnBackdrop.current && e.target === e.currentTarget) {
          onCloseRef.current();
        }
        downOnBackdrop.current = false;
      }}
    >
      {open && (
        <>
          <div className={s.head}>
            <span className={s.grip} aria-hidden="true" />
            <h2 id={titleId} className={s.title}>
              {title}
            </h2>
            <button
              type="button"
              className={s.close}
              onClick={() => onCloseRef.current()}
              aria-label="Close"
            >
              <Close size={22} />
            </button>
          </div>
          <div className={s.body}>{children}</div>
          {footer && <div className={s.foot}>{footer}</div>}
        </>
      )}
    </dialog>
  );
}
