"use client";

import { useEffect, useRef, type MouseEvent, type PointerEvent } from "react";

// How long a press must last to count as press-and-hold.
const HOLD_MS = 450;
// A finger that drifts further than this is scrolling, not holding.
const SLOP_PX = 10;

/**
 * Press-and-hold on a tile (finger or mouse): `onLong` fires after HOLD_MS
 * without the pointer wandering off. The tap that ends a hold is swallowed,
 * so holding a design to look at it never also picks it. Scrolling cancels
 * (the browser takes the pointer and sends pointercancel), and the phone's
 * own long-press menu ("Save image") is suppressed while a hold is live.
 *
 * Spread the returned handlers on the tile; pair with CSS
 * `-webkit-touch-callout: none` so iOS doesn't open its image callout.
 */
export function useLongPress<T extends HTMLElement = HTMLElement>(onLong: () => void) {
  const timer = useRef<number | undefined>(undefined);
  const fired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const cb = useRef(onLong);
  useEffect(() => {
    cb.current = onLong;
  }, [onLong]);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const cancel = () => {
    window.clearTimeout(timer.current);
    timer.current = undefined;
    start.current = null;
  };

  return {
    onPointerDown: (e: PointerEvent<T>) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      fired.current = false;
      start.current = { x: e.clientX, y: e.clientY };
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        timer.current = undefined;
        start.current = null;
        fired.current = true;
        try {
          navigator.vibrate?.(8);
        } catch {
          // vibration is a nicety; some browsers throw without a gesture
        }
        cb.current();
      }, HOLD_MS);
    },
    onPointerMove: (e: PointerEvent<T>) => {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > SLOP_PX) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu: (e: MouseEvent<T>) => {
      // the hold is ours: no "Save image / Open in new tab" menu
      if (fired.current || timer.current !== undefined) e.preventDefault();
    },
    onClickCapture: (e: MouseEvent<T>) => {
      if (!fired.current) return;
      fired.current = false;
      e.preventDefault();
      e.stopPropagation();
    },
  };
}
