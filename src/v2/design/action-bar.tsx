"use client";

import type { ReactNode } from "react";
import { Button } from "../ui/controls";
import f from "./flow.module.css";

export type Cta = {
  label: string;
  /** Fits beside the price on phones under 480px. */
  short?: string;
  onClick: (el: HTMLButtonElement) => void;
  busy?: boolean;
  /** Not ready yet — stays focusable and clickable; the click explains. */
  notReady?: boolean;
};

/**
 * ONE sticky bar (phones) / the options panel's sticky footer (desktop):
 * live thumbnail · price line + sub line · the step's single primary action.
 * The price opens a breakdown sheet. Everything the step has to say about
 * the action (a save status, a checkout error) sits right above the button.
 */
export default function ActionBar({
  thumb,
  main,
  sub,
  onPrice,
  cta,
  notice,
}: {
  thumb?: ReactNode;
  main: ReactNode;
  sub?: ReactNode;
  /** Opens the price breakdown (the visible price stays the button's name). */
  onPrice?: () => void;
  cta: Cta | null;
  notice?: ReactNode;
}) {
  const price = (
    <>
      {thumb && <span className={f.barThumb}>{thumb}</span>}
      <span className={f.barLines}>
        {onPrice && <span className={f.srOnly}>Price details: </span>}
        <span className={f.barMain}>{main}</span>
        {sub && <span className={f.barSub}>{sub}</span>}
      </span>
    </>
  );
  return (
    <div className={f.bar}>
      {notice && <div className={f.barNotice}>{notice}</div>}
      <div className={f.barRow}>
        {onPrice ? (
          <button type="button" className={f.barPrice} onClick={onPrice} aria-haspopup="dialog">
            {price}
          </button>
        ) : (
          <div className={f.barPrice}>{price}</div>
        )}
        {cta && (
          <Button
            onClick={(e) => cta.onClick(e.currentTarget)}
            busy={cta.busy}
            aria-disabled={cta.notReady || undefined}
          >
            {cta.short && cta.short !== cta.label ? (
              <>
                <span className={f.ctaLong}>{cta.label}</span>
                <span className={f.ctaShort}>{cta.short}</span>
              </>
            ) : (
              cta.label
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
