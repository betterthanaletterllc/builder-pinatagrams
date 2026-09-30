"use client";

import dynamic from "next/dynamic";
import Image from "next/image";
import { useRef, useState } from "react";
import DateCalendar from "@/app/design/date-calendar";
import {
  formatWindow,
  formatYmd,
  uspsWindow,
  type Carrier,
  type DeliveryConfig,
} from "@/lib/delivery";
import type { CartLine, GraphicChoice } from "@/lib/flow";
import type { HubBodyStyle, HubGraphicCategory, HubGraphicEntry } from "@/lib/hub";
import { cdnThumb } from "@/lib/library-data";
import { dateProblemText } from "../lib/dates";
import { bodyGroup } from "../lib/defaults";
import { PINATA_HEIGHT_IN } from "../lib/text";
import { Button } from "../ui/controls";
import { Callout, Skeleton } from "../ui/feedback";
import { Check } from "../ui/icons";
import Sheet from "../ui/sheet";
import s from "./steps.module.css";

// The full library is its own chunk (and fetches graphics.json itself):
// loaded when the sheet opens — or on hover/focus of "See all" — never with
// the page.
export const loadLibrary = () => import("@/app/design/graphic-library");
const GraphicLibrary = dynamic(loadLibrary, {
  ssr: false,
  loading: () => (
    <div aria-busy="true" style={{ display: "grid", gap: 12 }}>
      <Skeleton height={48} />
      <Skeleton height={140} />
      <Skeleton height={140} />
    </div>
  ),
});

/* --- Body style ------------------------------------------------------------------ */

export function BodySheet({
  open,
  onClose,
  styles,
  current,
  wearable,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  styles: HubBodyStyle[];
  current: string;
  wearable: (styleId: string) => boolean;
  onPick: (s: HubBodyStyle) => void;
}) {
  // A tap picks and closes; arrow keys only move the selection (closing on
  // every arrow press would make the list unbrowsable by keyboard) — "Done"
  // or Esc closes.
  const viaPointer = useRef(false);
  const groups = [
    { id: "everyday", label: "Everyday", items: styles.filter((b) => bodyGroup(b.id) === "everyday") },
    {
      id: "occasions",
      label: "Occasions & seasons",
      items: styles.filter((b) => bodyGroup(b.id) === "occasions"),
    },
  ].filter((g) => g.items.length > 0);
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Choose your piñata"
      full
      footer={
        <Button block onClick={onClose}>
          Done
        </Button>
      }
    >
      <div
        onPointerDown={() => {
          viaPointer.current = true;
        }}
        onKeyDown={() => {
          viaPointer.current = false;
        }}
      >
      <p className={s.small} style={{ margin: "0 0 12px" }}>
        Every piñata is {PINATA_HEIGHT_IN} inches tall.
      </p>
      {groups.map((g) => (
        <fieldset key={g.id} className={`${s.sheetGroup} ${s.legendReset}`}>
          <legend className={s.eyebrow}>{g.label}</legend>
          <div className={s.bodyGrid}>
            {g.items.map((b) => {
              const ok = wearable(b.id);
              return (
                <label
                  key={b.id}
                  className={s.bodyOption}
                  data-selected={b.id === current}
                  data-disabled={!ok || undefined}
                >
                  <input
                    type="radio"
                    name="pg-body"
                    className={s.srOnly}
                    checked={b.id === current}
                    disabled={!ok}
                    onChange={() => {
                      onPick(b);
                      if (viaPointer.current) onClose();
                    }}
                  />
                  <span className={s.bodyArt}>
                    <Image
                      src={b.cutoutUrl ?? `/pinatas/${b.id}.png`}
                      alt=""
                      width={400}
                      height={400}
                      sizes="(min-width: 768px) 120px, 30vw"
                    />
                  </span>
                  <span>{b.name}</span>
                  {!ok && <span className={s.small}>Not offered with this design</span>}
                  <span className={s.tileCheck} aria-hidden="true">
                    <Check size={12} />
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      </div>
    </Sheet>
  );
}

/* --- Zoom -------------------------------------------------------------------------- */

export function ZoomSheet({
  open,
  onClose,
  graphic,
  name,
}: {
  open: boolean;
  onClose: () => void;
  graphic: GraphicChoice | null;
  name: string;
}) {
  const art = !graphic
    ? null
    : graphic.type === "custom"
      ? graphic.preview
      : graphic.type === "hub"
        ? (graphic.thumb ?? graphic.art)
        : cdnThumb(graphic.art ?? graphic.thumb, 1400);
  return (
    <Sheet open={open} onClose={onClose} title="Your label, up close" tall>
      {art && (
        <div className={`${s.zoomArt}${graphic?.type === "custom" ? " ph-no-capture" : ""}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={art} alt={name} width={1400} height={683} />
        </div>
      )}
      <p className={s.zoomCaption}>Printed label · 8 × 3.9 in, on the front of the box</p>
    </Sheet>
  );
}

/* --- Library --------------------------------------------------------------------- */

export function LibrarySheet({
  open,
  onClose,
  restrict,
  hubGraphics,
  hubCategories,
  styleId,
  onPick,
  title = "All designs",
  initialView,
}: {
  open: boolean;
  onClose: () => void;
  restrict: "birthday" | "none" | null;
  hubGraphics: HubGraphicEntry[];
  hubCategories: HubGraphicCategory[];
  styleId: string;
  onPick: (g: GraphicChoice) => void;
  title?: string;
  /** Open on an occasion's aisle (or everything) — see libraryViewFor. */
  initialView?: { aisle: string | null; sub: string | null };
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title} wide full>
      <div className={s.library}>
        <GraphicLibrary
          restrict={restrict}
          hubGraphics={hubGraphics}
          hubCategories={hubCategories}
          styleId={styleId}
          onPick={onPick}
          initialView={initialView}
        />
      </div>
    </Sheet>
  );
}

/* --- Price breakdown ---------------------------------------------------------------- */

/* --- Carrier switch ---------------------------------------------------------------- */

const CARRIER_NAME: Record<Carrier, string> = { fedex: "FedEx 2-Day", usps: "USPS First Class" };

/** One order travels one way: picking the other carrier while piñatas are
 *  already in the order asks before switching them all. */
export function CarrierSwitchSheet({
  to,
  count,
  onConfirm,
  onClose,
}: {
  to: Carrier | null;
  count: number;
  onConfirm: (c: Carrier) => void;
  onClose: () => void;
}) {
  const from: Carrier = to === "usps" ? "fedex" : "usps";
  const one = count === 1;
  const them = one ? "the piñata" : `all ${count} piñatas`;
  return (
    <Sheet
      open={!!to}
      onClose={onClose}
      title={to ? `Switch everything to ${CARRIER_NAME[to]}?` : ""}
      footer={
        to && (
          <div className={s.sheetActions}>
            <Button block onClick={() => onConfirm(to)}>
              Switch all to {to === "usps" ? "USPS" : "FedEx"}
            </Button>
            <Button block variant="secondary" onClick={onClose}>
              Keep {CARRIER_NAME[from]}
            </Button>
          </div>
        )
      }
    >
      {to && (
        <p className={s.small} style={{ marginTop: 0 }}>
          Everything in one order ships the same way. Switching moves {them} already in
          your order from {CARRIER_NAME[from]} to {CARRIER_NAME[to]} too
          {to === "usps"
            ? one
              ? " — it would arrive within 2–3 business days of its date."
              : " — they'd arrive within 2–3 business days of their dates."
            : one
              ? " — it usually arrives on its exact day."
              : " — each usually arrives on its exact day."}
        </p>
      )}
    </Sheet>
  );
}

export type BreakdownRow = { label: string; value: string };

export function PriceSheet({
  open,
  onClose,
  rows,
  total,
  note,
}: {
  open: boolean;
  onClose: () => void;
  rows: BreakdownRow[];
  total: BreakdownRow;
  note?: string | null;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="What you're paying for">
      <dl style={{ margin: 0 }}>
        {rows.map((r) => (
          <div key={r.label} className={s.kv}>
            <dt>{r.label}</dt>
            <dd style={{ margin: 0 }}>{r.value}</dd>
          </div>
        ))}
        <div className={`${s.kv} ${s.total}`}>
          <dt>{total.label}</dt>
          <dd style={{ margin: 0 }}>{total.value}</dd>
        </div>
      </dl>
      <p className={s.tax}>Tax is added at payment.</p>
      {note && <p className={s.small}>{note}</p>}
    </Sheet>
  );
}

/* --- A cart line's date (carrier switches, stale dates) ------------------------------ */

/** Checkout tapped with no delivery date: a big, can't-miss ask instead of a
 *  line of red text — "Soonest" in one tap, or any day on the calendar,
 *  right here. */
export function DateNeededSheet({
  open,
  onClose,
  carrier,
  cfg,
  soonestYmd,
  onSoonest,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  carrier: Carrier | null;
  cfg: DeliveryConfig;
  soonestYmd: string | null;
  onSoonest: () => void;
  onPick: (ymd: string) => void;
}) {
  return (
    <Sheet open={open} onClose={onClose} title="Pick a delivery date" tall>
      <p className={s.small} style={{ marginTop: 0 }}>
        When should it arrive? Choose a day to check out.
      </p>
      {carrier && soonestYmd && (
        <>
          <div style={{ marginTop: 12 }}>
            <Button block onClick={onSoonest}>
              Soonest ·{" "}
              {carrier === "usps"
                ? formatWindow(uspsWindow(soonestYmd, cfg))
                : formatYmd(soonestYmd)}
            </Button>
          </div>
          <div className={s.calendar}>
            <DateCalendar key={carrier} value="" onChange={onPick} cfg={cfg} carrier={carrier} />
          </div>
        </>
      )}
    </Sheet>
  );
}

export function LineDateSheet({
  open,
  onClose,
  line,
  title,
  carrier,
  cfg,
  onPick,
}: {
  open: boolean;
  onClose: () => void;
  line: CartLine | null;
  title: string;
  carrier: Carrier;
  cfg: DeliveryConfig;
  onPick: (ymd: string) => void;
}) {
  const [value, setValue] = useState(line?.deliveryDate ?? "");
  const problem = value ? dateProblemText(value, cfg, carrier) : "Pick a day on the calendar.";
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="New delivery date"
      footer={
        <Button block onClick={() => !problem && onPick(value)} aria-disabled={!!problem || undefined}>
          Use this date
        </Button>
      }
    >
      <p className={s.small} style={{ marginTop: 0 }}>
        {title}
      </p>
      <div className={s.calendar}>
        <DateCalendar key={carrier} value={value} onChange={setValue} cfg={cfg} carrier={carrier} />
      </div>
      {carrier === "usps" && value && !problem && (
        <p className={s.assure} data-tone="window">
          Usually arrives {formatWindow(uspsWindow(value, cfg))}.
        </p>
      )}
      {problem && value && (
        <div style={{ marginTop: 12 }}>
          <Callout tone="error">{problem}</Callout>
        </div>
      )}
    </Sheet>
  );
}
