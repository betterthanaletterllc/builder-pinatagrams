"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "../ui/icons";
import s from "./home.module.css";

/**
 * A swipeable row of review cards (all-in landing). Native horizontal scroll
 * with snap points — phones swipe, the next card peeks in at the edge; on
 * pointer devices two arrow buttons page through it. No auto-advance.
 */
export default function ReviewSlider({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () =>
      setEdges({
        start: el.scrollLeft <= 4,
        end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4,
      });
    update();
    el.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      el.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  const page = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollBy({ left: dir * el.clientWidth * 0.9, behavior: reduce ? "auto" : "smooth" });
  };

  return (
    <div className={s.slider}>
      <ul ref={ref} className={s.sliderTrack} aria-label={label} tabIndex={0}>
        {children}
      </ul>
      <button
        type="button"
        className={`${s.sliderBtn} ${s.sliderPrev}`}
        onClick={() => page(-1)}
        disabled={edges.start}
        aria-label="Previous reviews"
      >
        <ChevronLeft size={20} />
      </button>
      <button
        type="button"
        className={`${s.sliderBtn} ${s.sliderNext}`}
        onClick={() => page(1)}
        disabled={edges.end}
        aria-label="More reviews"
      >
        <ChevronRight size={20} />
      </button>
    </div>
  );
}
