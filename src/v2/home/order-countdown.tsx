"use client";

import { useEffect, useState } from "react";
import { formatYmd, type DeliveryConfig } from "@/lib/delivery";
import { orderDeadline } from "../lib/dates";
import { Truck } from "../ui/icons";
import s from "./home.module.css";

function format(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const sec = secs % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m ${String(sec).padStart(2, "0")}s`;
}

/** "Order within 4h 12m 09s to get it as soon as Mon, Nov 9" — live. */
export default function OrderCountdown({
  cfg,
  initial,
}: {
  cfg: DeliveryConfig;
  /** The server's render (same math), so hydration matches. */
  initial: { arrive: string; secondsLeft: number };
}) {
  const [state, setState] = useState(initial);

  useEffect(() => {
    const tick = () => setState(orderDeadline(cfg));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [cfg]);

  return (
    <p className={s.countdown}>
      <Truck size={18} />
      <span>
        Order within{" "}
        <strong className={s.countdownTime} suppressHydrationWarning>
          {format(Math.max(0, state.secondsLeft))}
        </strong>{" "}
        to get it as soon as <strong>{formatYmd(state.arrive)}</strong>
      </span>
    </p>
  );
}
