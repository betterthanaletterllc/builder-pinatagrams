"use client";

import { useEffect, useState } from "react";
import { ButtonLink } from "../ui/controls";
import s from "./home.module.css";

/**
 * The landing page's sticky bottom bar (all-in storefronts): the one price,
 * the soonest arrival and "Send one" — the same shape as the builder's own
 * bar. It shows once the hero's button has scrolled out of view, so the
 * first screen keeps a single primary action.
 */
export default function StickyCta({
  watchId,
  price,
  arrive,
}: {
  /** The hero CTA's id; the bar hides while that button is on screen. */
  watchId: string;
  price: string | null;
  arrive: string;
}) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const el = document.getElementById(watchId);
    if (!el || typeof IntersectionObserver === "undefined") {
      setShow(true);
      return;
    }
    const io = new IntersectionObserver(([e]) => setShow(!e.isIntersecting), {
      rootMargin: "0px 0px -40px 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, [watchId]);

  return (
    <div className={s.stickyBar} data-show={show} aria-hidden={!show}>
      <div className={s.stickyRow}>
        <p className={s.stickyLines}>
          {price && <strong>{price}</strong>}
          <span>Arrives as soon as {arrive}</span>
        </p>
        <ButtonLink href="/design" tabIndex={show ? undefined : -1}>
          Send one
        </ButtonLink>
      </div>
    </div>
  );
}
