"use client";

import { useState, type ReactNode } from "react";
import { formatCents } from "@/lib/hub";
import type { LineView } from "../lib/order";
import BoxThumb from "../ui/box-thumb";
import { Button } from "../ui/controls";
import { Callout } from "../ui/feedback";
import { Calendar, Pencil } from "../ui/icons";
import s from "./steps.module.css";

/**
 * Every piñata in the order (the one in progress first), then shipping,
 * codes and the total — display only; Shopify's invoice is the true total.
 * Rows can be edited or removed (removal asks once, inline); a row whose
 * date no longer works gets its own "Pick a new date".
 */
export default function OrderSummary({
  lines,
  shipping,
  discounts,
  total,
  onEdit,
  onRemove,
  onFixDate,
  footer,
}: {
  lines: LineView[];
  shipping: { label: string; cents: number | null; from: boolean };
  discounts: { label: string; cents: number }[];
  total: { cents: number | null; from: boolean };
  onEdit: (id: string) => void;
  onRemove: (id: string) => void;
  onFixDate: (id: string) => void;
  footer?: ReactNode;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const money = (c: number | null, from = false) =>
    c === null ? "—" : `${from ? "From " : ""}${formatCents(c)}`;

  return (
    <div className={s.summary}>
      <ul className={s.lines}>
        {lines.map((l) => (
          <li
            key={l.id}
            id={`pg-line-${l.id}`}
            className={s.line}
            data-problem={!!(l.problem || l.error) || undefined}
          >
            <BoxThumb {...l.box} size={56} />
            <div className={s.lineInfo}>
              {l.tag && <span className={s.lineTag}>{l.tag}</span>}
              <span className={s.lineTitle}>
                {l.title}
                {l.qty > 1 && ` × ${l.qty}`}
              </span>
              {/* filling + message excerpt: masked in session replay */}
              {l.details && <span data-ph-mask>{l.details}</span>}
              {l.arrives && <span>Arrives {l.arrives}</span>}
              {l.addonRows.map((a) => (
                <span key={a.label}>
                  + {a.label} {formatCents(a.cents)}
                </span>
              ))}
            </div>
            <span className={s.linePrice}>{money(l.merchCents)}</span>

            {(l.problem || l.error) && (
              <div className={s.lineError}>
                <Callout tone="error" role={l.error ? "alert" : undefined}>
                  <p>{l.error ?? l.problem}</p>
                  {l.problem && !l.current && (
                    <p>
                      <Button
                        id={`pg-fix-${l.id}`}
                        variant="secondary"
                        size="sm"
                        onClick={() => onFixDate(l.id)}
                      >
                        <Calendar size={18} /> Pick a new date
                      </Button>
                    </p>
                  )}
                </Callout>
              </div>
            )}

            {confirming === l.id ? (
              <div className={s.confirm} role="group" aria-label={`Remove ${l.title}?`}>
                <span>Remove this piñata?</span>
                <button
                  type="button"
                  className={s.linkBtn}
                  onClick={() => {
                    setConfirming(null);
                    onRemove(l.id);
                  }}
                >
                  Remove
                </button>
                <button type="button" className={s.linkBtn} onClick={() => setConfirming(null)}>
                  Keep it
                </button>
              </div>
            ) : (
              <div className={s.lineActions}>
                <button type="button" className={s.linkBtn} onClick={() => onEdit(l.id)}>
                  <Pencil size={16} /> Edit<span className={s.srOnly}> {l.title}</span>
                </button>
                <button type="button" className={s.linkBtn} onClick={() => setConfirming(l.id)}>
                  Remove<span className={s.srOnly}> {l.title}</span>
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <dl style={{ margin: 0 }}>
        <div className={s.kv}>
          <dt>{shipping.label}</dt>
          <dd style={{ margin: 0 }}>{money(shipping.cents, shipping.from)}</dd>
        </div>
        {discounts.map((d) => (
          <div key={d.label} className={`${s.kv} ${s.kvDiscount}`}>
            <dt>{d.label}</dt>
            <dd style={{ margin: 0 }}>−{formatCents(d.cents)}</dd>
          </div>
        ))}
        <div className={`${s.kv} ${s.total}`}>
          <dt>Total</dt>
          <dd style={{ margin: 0 }}>{money(total.cents, total.from)}</dd>
        </div>
      </dl>
      <p className={s.tax}>Tax is added at payment.</p>
      {footer}
    </div>
  );
}
