"use client";

import { forwardRef, useId, useState, type ComponentProps, type ReactNode } from "react";
import DateCalendar from "@/app/design/date-calendar";
import {
  formatWindow,
  formatYmd,
  uspsWindow,
  uspsWindowLabel,
  type Carrier,
  type DeliveryConfig,
} from "@/lib/delivery";
import { formatCents } from "@/lib/hub";
import { CORPORATE_URL } from "@/lib/links";
import { cutoffTonight, soonest } from "../lib/dates";
import { OptionCard } from "../ui/controls";
import { Callout, StepHeader } from "../ui/feedback";
import { TextField } from "../ui/field";
import { Alert, Mail, Plus, Users } from "../ui/icons";
import u from "../ui/ui.module.css";
import DiscountBox from "./discount-box";
import OrderSummary from "./order-summary";
import Recipient from "./recipient";
import s from "./steps.module.css";

export const DATE_IDS = { soonest: "pg-date-soonest", pick: "pg-date-pick" };
export const CARRIER_IDS: Record<Carrier, string> = {
  fedex: "pg-carrier-fedex",
  usps: "pg-carrier-usps",
};
export const EMAIL_ID = "pg-email";

type RecipientProps = Omit<ComponentProps<typeof Recipient>, "headingId">;

/**
 * Step 4 · Deliver & pay — "When and where", and the order review. The
 * carrier (two-carrier stores only) applies to the WHOLE order — switching
 * with piñatas already in it asks first (the flow's pop-up); USPS shows its
 * window in words and on the calendar. The date is never silently
 * preselected: "Soonest" is one tap, and the calendar is always open below
 * it. With no piñata in progress (arriving from the cart icon) it's just the
 * order: every line with its date, the recipient, and "Continue to payment".
 */
const StepDeliver = forwardRef<
  HTMLHeadingElement,
  {
    hasPiece: boolean;
    /** Not while editing a line, nor for "someone else" (a separate order). */
    canAddAnother: boolean;
    uspsOffered: boolean;
    carrier: Carrier | null;
    onCarrier: (c: Carrier) => void;
    fedexCents: number | null;
    uspsCents: number;
    carrierError: string | null;
    carrierNotice: ReactNode;
    cfg: DeliveryConfig;
    date: string;
    dateSoonest: boolean;
    dateError: string | null;
    onSoonest: () => void;
    /** Soonest tapped again: no date until they pick one. */
    onClearDate: () => void;
    onDate: (ymd: string) => void;
    /** All-in storefronts: no "Soonest" option — the soonest day is
     *  already chosen on the calendar (the flow preselects it). */
    soonestPreselected?: boolean;
    /** The paid guaranteed date, cents per piñata — null = not offered
     *  (no toggle). FedEx only. */
    guaranteeCents?: number | null;
    guaranteed?: boolean;
    onGuaranteed?: (on: boolean) => void;
    recipient: RecipientProps;
    email: string;
    emailError: string | null;
    onEmail: (v: string) => void;
    onEmailBlur: () => void;
    summary: ComponentProps<typeof OrderSummary>;
    discount: ComponentProps<typeof DiscountBox>;
    onAddAnother: (el: HTMLButtonElement) => void;
    result: ReactNode;
  }
>(function StepDeliver(p, h1Ref) {
  const carrierH = useId();
  const dateH = useId();
  const whoH = useId();
  const orderH = useId();
  const soonestYmd = p.carrier ? soonest(p.cfg, p.carrier) : null;
  const perPiece = (c: number | null) => (c === null ? "—" : formatCents(c));
  // All-in storefronts: the date question IS the step's headline (no
  // "When and where" above it, no repeated sub-heading).
  const dateIsTitle = !!p.soonestPreselected && p.hasPiece;
  const guaranteeId = useId();
  const [guaranteeHelp, setGuaranteeHelp] = useState(false);

  return (
    <div>
      <StepHeader
        ref={h1Ref}
        index={3}
        title={dateIsTitle ? "When should it arrive?" : "When and where"}
      />

      {p.uspsOffered && (
        <section className={s.section} aria-labelledby={carrierH}>
          <h2 id={carrierH} className={s.h2}>
            How should it travel?
          </h2>
          <fieldset className={`${s.options} ${s.twoUp}`} aria-labelledby={carrierH}>
            <OptionCard
              inputId={CARRIER_IDS.fedex}
              name="pg-carrier"
              value="fedex"
              checked={p.carrier === "fedex"}
              onChange={() => p.onCarrier("fedex")}
              title="FedEx"
              description="Expected to arrive on the exact date you pick"
              aside={perPiece(p.fedexCents)}
            />
            <OptionCard
              inputId={CARRIER_IDS.usps}
              name="pg-carrier"
              value="usps"
              checked={p.carrier === "usps"}
              onChange={() => p.onCarrier("usps")}
              title="USPS First Class"
              description="Arrives within 2–3 business days of your selected date"
              aside={perPiece(p.uspsCents)}
            />
          </fieldset>
          {p.carrierError && (
            <p className={u.error} style={{ marginTop: 8 }}>
              <Alert size={16} />
              <span>{p.carrierError}</span>
            </p>
          )}
          {p.carrierNotice && <div className={s.block}>{p.carrierNotice}</div>}
        </section>
      )}

      {p.hasPiece && (
        <section
          className={s.section}
          aria-labelledby={dateIsTitle ? undefined : dateH}
          aria-label={dateIsTitle ? "When should it arrive?" : undefined}
        >
          {!dateIsTitle && (
            <h2 id={dateH} className={s.h2}>
              When should it arrive?
            </h2>
          )}
          {!p.carrier || !soonestYmd ? (
            <Callout>Choose how it travels to see delivery dates.</Callout>
          ) : (
            <>
              {p.soonestPreselected ? null : (
              /* "Soonest" is one tap; the calendar right under it is always
                  open for any other day. Neither is preselected. */
              <fieldset className={s.options} aria-labelledby={dateH}>
                {/* a toggle: tap again to clear it (then pick in the calendar) */}
                <OptionCard
                  type="checkbox"
                  inputId={DATE_IDS.soonest}
                  name="pg-date"
                  value="soonest"
                  checked={!!p.date && p.date === soonestYmd}
                  onChange={(e) => (e.target.checked ? p.onSoonest() : p.onClearDate())}
                  title={`Soonest · ${
                    p.carrier === "usps"
                      ? formatWindow(uspsWindow(soonestYmd, p.cfg))
                      : formatYmd(soonestYmd)
                  }`}
                  description={
                    cutoffTonight(p.cfg, p.carrier)
                      ? "Order by midnight CT tonight"
                      : "The earliest it can get there"
                  }
                />
              </fieldset>
              )}
              <div id={DATE_IDS.pick} className={s.calendar} tabIndex={-1}>
                <DateCalendar
                  key={p.carrier}
                  value={p.date}
                  onChange={p.onDate}
                  cfg={p.cfg}
                  carrier={p.carrier}
                />
                {p.carrier === "usps" && p.date && !p.dateError && (
                  <ul className={s.legend}>
                    <li>
                      <span className={`${s.swatch} ${s.swatchTarget}`} aria-hidden="true" />
                      Your target day
                    </li>
                    <li>
                      <span className={`${s.swatch} ${s.swatchWindow}`} aria-hidden="true" />
                      Days it may arrive
                    </li>
                  </ul>
                )}
              </div>
              {p.guaranteeCents && p.carrier === "fedex" ? (
                <div className={s.guarantee}>
                  <div className={s.guaranteeRow}>
                    <label className={s.guaranteeToggle}>
                      <input
                        type="checkbox"
                        role="switch"
                        checked={!!p.guaranteed}
                        aria-describedby={guaranteeHelp ? `${guaranteeId}-help` : undefined}
                        onChange={(e) => p.onGuaranteed?.(e.target.checked)}
                      />
                      <span className={s.switchTrack} aria-hidden="true">
                        <span className={s.switchThumb} />
                      </span>
                      <span className={s.guaranteeLabel}>Guaranteed delivery date</span>
                      <span className={s.guaranteePrice}>+{formatCents(p.guaranteeCents)}</span>
                    </label>
                    <button
                      type="button"
                      className={s.helpBtn}
                      aria-label="What is the guaranteed delivery date?"
                      aria-expanded={guaranteeHelp}
                      aria-controls={`${guaranteeId}-help`}
                      onClick={() => setGuaranteeHelp((v) => !v)}
                    >
                      ?
                    </button>
                  </div>
                  {guaranteeHelp && (
                    <p id={`${guaranteeId}-help`} className={s.guaranteeHelp}>
                      With the guarantee, your piñata arrives on the date you picked, or you get a
                      full refund. Without it, we send it to arrive on your date, but it may arrive
                      within a business day or two of it.
                    </p>
                  )}
                </div>
              ) : null}
              {p.carrier === "usps" && (
                <p className={s.assure} data-tone="window">
                  <Mail size={18} />
                  <span>
                    {p.date && !p.dateError
                      ? `Usually arrives ${formatWindow(uspsWindow(p.date, p.cfg))} — First Class mail lands within ${uspsWindowLabel(p.cfg)} of the day you pick.`
                      : `First Class mail usually lands within ${uspsWindowLabel(p.cfg)} of the day you pick.`}
                  </span>
                </p>
              )}
              {p.dateError && (
                <p className={u.error} style={{ marginTop: 8 }} role="status">
                  <Alert size={16} />
                  <span>{p.dateError}</span>
                </p>
              )}
            </>
          )}
        </section>
      )}

      <section className={s.section} aria-labelledby={whoH}>
        <h2 id={whoH} className={s.h2}>
          Who&apos;s it for?
        </h2>
        <Recipient headingId={whoH} {...p.recipient} />
      </section>

      <section className={s.section}>
        <TextField
          id={EMAIL_ID}
          label="Email for your receipt"
          optional
          type="email"
          inputMode="email"
          autoComplete="email"
          spellCheck={false}
          maxLength={120}
          value={p.email}
          error={p.emailError}
          onChange={(e) => p.onEmail(e.target.value)}
          onBlur={p.onEmailBlur}
        />
      </section>

      <section className={s.section} aria-labelledby={orderH}>
        <h2 id={orderH} className={s.h2}>
          Your order
        </h2>
        <OrderSummary {...p.summary} footer={<DiscountBox {...p.discount} />} />
        <div className={s.moreLinks}>
          {p.canAddAnother && (
            <button
              type="button"
              className={s.linkBtn}
              onClick={(e) => p.onAddAnother(e.currentTarget)}
            >
              <Plus size={18} /> Add another piñata
            </button>
          )}
          <a className={s.linkBtn} href={CORPORATE_URL}>
            <Users size={18} /> Sending to several people?
          </a>
        </div>
      </section>

      {p.result}
    </div>
  );
});

export default StepDeliver;
