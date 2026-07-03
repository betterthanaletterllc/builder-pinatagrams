"use client";

import { useState } from "react";
import {
  deliveryProblem,
  fromYmd,
  maxDeliveryDate,
  minDeliveryDate,
  toYmd,
} from "@/lib/delivery";

/**
 * Inline month calendar — always open, no popup to summon (native date inputs
 * need an extra tap and iOS can't be auto-opened reliably). Undeliverable
 * days (lead time, blackouts, Sundays) render disabled.
 */

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DOW = ["S", "M", "T", "W", "T", "F", "S"];

export default function DateCalendar({
  value,
  onChange,
}: {
  value: string; // "" = nothing chosen yet
  onChange: (ymd: string) => void;
}) {
  const [view, setView] = useState(() => {
    const d = value ? fromYmd(value) : fromYmd(minDeliveryDate());
    return { y: d.getFullYear(), m: d.getMonth() };
  });

  const min = fromYmd(minDeliveryDate());
  const max = fromYmd(maxDeliveryDate());
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
                (deliveryProblem(ymd) ? " off" : "")
              }
              disabled={!!deliveryProblem(ymd)}
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
