"use client";

import { useEffect, useRef, useState } from "react";
import { stateCode, US_STATES } from "@/lib/flow";

/**
 * Shopify-checkout-style address autocomplete: the Address field ITSELF
 * suggests as you type — pick one and street/city/state/ZIP fill in.
 * Backed by Photon (OpenStreetMap's geocoder) — free, keyless, CORS-open;
 * the query is boxed to the US, house-number results sort first, and a
 * suggestion needs a street + city + state to be offered.
 * Service down or address unknown → the field is just a normal input (and
 * the browser's own address autofill works on it too).
 *
 * An ARIA 1.2 combobox: arrows move through the list, Enter picks, Escape
 * closes, and a pointer pick lands on click — so taps work on touch screens
 * and in in-app browsers, not just mouse presses.
 * (Upgrade path: swap the fetch for Google Places behind the same UI.)
 */

export type PickedAddress = {
  address1: string;
  city: string;
  province: string;
  zip: string;
};

type Suggestion = PickedAddress & { label: string };

// The 50 states + DC live once, in lib/flow (the cart's State select uses
// them too); re-exported here for the flow's existing imports.
export { US_STATES, stateCode };

const STATE_CODES: Record<string, string> = Object.fromEntries(
  US_STATES.map(([code, name]) => [name, code]),
);

// The US (incl. Alaska + Hawaii) as Photon's minLon,minLat,maxLon,maxLat —
// results elsewhere never make the list, so they shouldn't crowd it out.
const US_BBOX = "-179.2,18.9,-66.9,71.4";

type PhotonProps = {
  countrycode?: string;
  housenumber?: string;
  street?: string;
  name?: string;
  city?: string;
  town?: string;
  village?: string;
  district?: string;
  state?: string;
  postcode?: string;
};

export default function AddressLine1({
  value,
  onChange,
  onPick,
  inputId = "addr-address1",
  label = "Address",
  autoComplete = "section-recipient shipping address-line1",
  error,
  onBlur,
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (a: PickedAddress) => void;
  // Optional (older callers pass none of these):
  inputId?: string;
  label?: string;
  autoComplete?: string;
  // Inline validation message rendered under the field.
  error?: string;
  onBlur?: () => void;
}) {
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const timer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  // Newest request wins — a slow older response must not replace newer
  // suggestions.
  const reqId = useRef(0);
  // After a pick, the field holds the chosen street — don't re-search it.
  const picked = useRef<string | null>(null);
  const listId = `${inputId}-sugs`;

  useEffect(() => {
    window.clearTimeout(timer.current);
    // Any change of value invalidates responses still in flight (even a
    // cleared field — a late answer must not pop a list open under it).
    const id = ++reqId.current;
    if (value.trim().length < 5 || value === picked.current) {
      setSugs([]);
      setOpen(false);
      setActive(-1);
      return;
    }
    timer.current = window.setTimeout(async () => {
      try {
        const r = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(value)}&limit=8&lang=en&layer=house&layer=street&bbox=${US_BBOX}`,
        );
        if (!r.ok || id !== reqId.current) return;
        const j = await r.json();
        const out: (Suggestion & { house: boolean })[] = [];
        for (const f of j.features ?? []) {
          const p: PhotonProps = f.properties ?? {};
          if (p.countrycode !== "US") continue;
          const street = [p.housenumber, p.street ?? p.name]
            .filter(Boolean)
            .join(" ");
          const city = p.city ?? p.town ?? p.village ?? p.district ?? "";
          const province = STATE_CODES[p.state ?? ""] ?? "";
          if (!street || !city || !province) continue;
          const zip = p.postcode ?? "";
          const label = `${street}, ${city}, ${province}${zip ? ` ${zip}` : ""}`;
          if (out.some((s) => s.label === label)) continue;
          out.push({
            label,
            address1: street,
            city,
            province,
            zip,
            house: !!p.housenumber,
          });
        }
        // A real door (house number) beats a bare street; stable otherwise.
        out.sort((a, b) => Number(b.house) - Number(a.house));
        if (id !== reqId.current) return;
        const list: Suggestion[] = out.slice(0, 6).map((s) => ({
          label: s.label,
          address1: s.address1,
          city: s.city,
          province: s.province,
          zip: s.zip,
        }));
        setSugs(list);
        setActive(-1);
        setOpen(list.length > 0);
      } catch {
        // service hiccup — plain typing is unaffected
      }
    }, 300);
    return () => window.clearTimeout(timer.current);
  }, [value]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const choose = (s: Suggestion) => {
    window.clearTimeout(closeTimer.current);
    picked.current = s.address1;
    onPick(s);
    setOpen(false);
    setSugs([]);
    setActive(-1);
  };

  return (
    <>
      <div className={"ffield addr-line1" + (error ? " invalid" : "")}>
        <input
          id={inputId}
          value={value}
          autoComplete={autoComplete}
          placeholder=" "
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={
            open && active >= 0 ? `${listId}-${active}` : undefined
          }
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-err` : undefined}
          onChange={(e) => {
            picked.current = null;
            onChange(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              if (!sugs.length) return;
              e.preventDefault();
              if (!open) {
                setOpen(true);
                setActive(0);
              } else {
                setActive((a) => (a + 1) % sugs.length);
              }
            } else if (e.key === "ArrowUp") {
              if (!open || !sugs.length) return;
              e.preventDefault();
              setActive((a) => (a <= 0 ? sugs.length - 1 : a - 1));
            } else if (e.key === "Enter") {
              if (open && active >= 0 && sugs[active]) {
                e.preventDefault();
                choose(sugs[active]);
              }
            } else if (e.key === "Escape") {
              if (open) {
                e.preventDefault();
                setOpen(false);
                setActive(-1);
              }
            }
          }}
          onBlur={() => {
            // Close a beat later: a tap on a suggestion blurs on some touch
            // browsers before its click lands; choose() cancels this.
            window.clearTimeout(closeTimer.current);
            closeTimer.current = window.setTimeout(() => {
              setOpen(false);
              setActive(-1);
            }, 250);
            onBlur?.();
          }}
          onFocus={() => {
            window.clearTimeout(closeTimer.current);
            if (sugs.length > 0 && value !== picked.current) setOpen(true);
          }}
        />
        <label htmlFor={inputId}>{label}</label>
        {open && (
          <ul
            className="addr-sugs"
            role="listbox"
            id={listId}
            aria-label="Address suggestions"
          >
            {sugs.map((s, i) => (
              <li
                key={s.label}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className={"addr-sug" + (i === active ? " active" : "")}
                // Keep focus (and the phone keyboard) in the field on mouse
                // presses; the pick itself happens on click, which every
                // pointer — finger, mouse, pen — produces.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(s)}
              >
                {s.label}
              </li>
            ))}
          </ul>
        )}
      </div>
      {/* After the field box (the floating label centers on the box); the
          suggestion list stays anchored right under the input. */}
      {error && (
        <p className="field-err" id={`${inputId}-err`}>
          {error}
        </p>
      )}
    </>
  );
}
