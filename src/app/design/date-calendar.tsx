"use client";

import { useState } from "react";
import {
  deliveryProblem,
  fromYmd,
  maxDeliveryDate,
  minDeliveryDate,
  toYmd,
  uspsDeliveryDay,
  uspsWindow,
  type Carrier,
  type DeliveryConfig,
} from "@/lib/delivery";

/**
 * Inline month calendar — always open, no popup to summon (native date inputs
 * need an extra tap and iOS can't be auto-opened reliably). Undeliverable
 * days (make+fly lead time, carrier holidays, FedEx off-days) render disabled;
 * the rules come from the hub's delivery calendars (admin /delivery).
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW = ["S", "M", "T", "W", "T", "F", "S"];

export default function DateCalendar({
  value,
  onChange,
  cfg,
  carrier = "fedex",
}: {
  value: string; // "" = nothing chosen yet
  onChange: (ymd: string) => void;
  cfg: DeliveryConfig;
  carrier?: Carrier;
}) {
  const [view, setView] = useState(() => {
    const d = value ? fromYmd(value) : fromYmd(minDeliveryDate(cfg, carrier));
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  const min = fromYmd(minDeliveryDate(cfg, carrier));
  const max = fromYmd(maxDeliveryDate(cfg));
  const atMin =
    view.y === min.getFullYear() && view.m === min.getMonth();
  const atMax =
    view.y === max.getFullYear() && view.m === max.getMonth();

  const step = (dir: 1 | -1) =>
    setView(({ y, m }) => {
      const d = new Date(y, m + dir, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });

  const firstDow = new Date(view.y, view.m, 1).getDay();
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate();
  const cells: (string | null)[] = [
    ...Array.from({ length: firstDow }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) =>
      toYmd(new Date(view.y, view.m, i + 1)),
    ),
  ];

  // USPS: the promised arrival window shades onto the calendar — the picked
  // day at full strength, the window's mailing days either side lighter
  // (cfg.uspsWindowDays each way, hub-tunable). Days
  // USPS can't deliver (Sundays, postal holidays) inside the span stay
  // unshaded: the piñata can't arrive then.
  const win = carrier === "usps" && value ? uspsWindow(value, cfg) : null;
  const inWindow = (ymd: string) =>
    !!win &&
    ymd >= win.start &&
    ymd <= win.end &&
    ymd !== value &&
    uspsDeliveryDay(ymd, cfg);

  return (
    <div className="cal">
      <div className="cal-head">
        <button
          type="button"
          className="btn mini"
          disabled={atMin}
          onClick={() => step(-1)}
          aria-label="Previous month"
        >
          ‹
        </button>
        <strong>
          {MONTHS[view.m]} {view.y}
        </strong>
        <button
          type="button"
          className="btn mini"
          disabled={atMax}
          onClick={() => step(1)}
          aria-label="Next month"
        >
          ›
        </button>
      </div>
      <div className="cal-grid">
        {DOW.map((d, i) => (
          <span key={`${d}${i}`} className="cal-dow">
            {d}
          </span>
        ))}
        {cells.map((ymd, i) =>
          ymd === null ? (
            <span key={`pad${i}`} />
          ) : (
            <button
              key={ymd}
              type="button"
              className={
                "cal-day" +
                (ymd === value ? " selected" : "") +
                (inWindow(ymd) ? " win" : "") +
                (deliveryProblem(ymd, cfg, carrier) ? " off" : "")
              }
              disabled={!!deliveryProblem(ymd, cfg, carrier)}
              aria-label={`${MONTHS[view.m]} ${Number(ymd.slice(8))}, ${view.y}${
                deliveryProblem(ymd, cfg, carrier) ? " — unavailable" : ""
              }`}
              aria-pressed={ymd === value}
              onClick={() => onChange(ymd)}
            >
              {Number(ymd.slice(8))}
            </button>
          ),
        )}
      </div>
    </div>
  );
}
