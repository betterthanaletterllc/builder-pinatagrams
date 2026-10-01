"use client";

import { useEffect, useRef, useState } from "react";
import { stateCode, US_STATES } from "@/lib/flow";

/**
 * Shopify-checkout-style address autocomplete: the Address field ITSELF
 * suggests as you type — pick one and street/city/state/ZIP fill in.
 * Backed by Google Places through /api/address (one billed session per
 * address: the keystrokes and the final pick share a session token). No
 * key configured, or Google unreachable → Photon (OpenStreetMap's geocoder,
 * free, keyless): boxed to the US, house-number results first, and a
 * suggestion needs a street + city + state to be offered.
 * Both down or address unknown → the field is just a normal input (and the
 * browser's own address autofill works on it too).
 *
 * An ARIA 1.2 combobox: arrows move through the list, Enter picks, Escape
 * closes, and a pointer pick lands on click — so taps work on touch screens
 * and in in-app browsers, not just mouse presses.
 */

export type PickedAddress = {
  address1: string;
  city: string;
  province: string;
  zip: string;
};

// A Google suggestion carries only its place id until it's picked; the
// address parts come from the pick's Details call.
type Suggestion = PickedAddress & { label: string; placeId?: string };

// Set once /api/address says Google isn't configured: Photon from then on.
let googleOff = false;

const newSession = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;

/** Google's suggestions for the typed line — null means "use Photon". */
async function googleSuggest(value: string, session: string): Promise<Suggestion[] | null> {
  if (googleOff) return null;
  const r = await fetch(
    `/api/address?q=${encodeURIComponent(value)}&session=${encodeURIComponent(session)}`,
  );
  if (r.status === 503) googleOff = true;
  if (!r.ok) return null;
  const j: { suggestions?: { id: string; main: string; secondary: string }[] } = await r.json();
  return (j.suggestions ?? []).map((s) => ({
    label: s.secondary ? `${s.main}, ${s.secondary}` : s.main,
    address1: s.main,
    city: "",
    province: "",
    zip: "",
    placeId: s.id,
  }));
}

/** A picked Google suggestion → its address parts, or null on any hiccup. */
async function googleDetails(
  s: Suggestion,
  session: string,
  typed: { number: string; dir: string },
): Promise<PickedAddress | null> {
  try {
    const r = await fetch(
      `/api/address?place=${encodeURIComponent(s.placeId!)}&session=${encodeURIComponent(session)}`,
    );
    if (!r.ok) return null;
    const j: {
      address: { number: string; street: string; city: string; province: string; zip: string } | null;
    } = await r.json();
    const a = j.address;
    if (!a || !a.street || !a.city || !US_STATES.some(([code]) => code === a.province)) return null;
    // Same rule as Photon's: a pick only ADDS to what was typed.
    if (typed.number && a.number && a.number.toLowerCase() !== typed.number.toLowerCase())
      return null;
    const number = a.number || typed.number;
    return {
      address1: number ? `${number} ${a.street}` : a.street,
      city: a.city,
      province: a.province,
      // a street without a door spans several ZIPs: never guess theirs
      zip: a.number ? a.zip : "",
    };
  } catch {
    return null;
  }
}

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

/*
 * A suggestion may only ADD to what the shopper typed, never change it.
 * OpenStreetMap (Photon's data) often stores a street without its direction
 * ("Main Street" for 1600 S Main St), answers a door number with a
 * neighbour's, has only the street (no door), or packs a whole address
 * into the street name — and a pick used to copy all of that over the
 * typed line, dropping "S", the house number, or worse.
 */
const DIRECTION = /^(north|south|east|west|northeast|northwest|southeast|southwest|n|s|e|w|ne|nw|se|sw)\.?(?=\s)/i;
const DIR_KEY: Record<string, string> = {
  n: "n", north: "n", s: "s", south: "s", e: "e", east: "e", w: "w", west: "w",
  ne: "ne", northeast: "ne", nw: "nw", northwest: "nw",
  se: "se", southeast: "se", sw: "sw", southwest: "sw",
};

/** The typed street line: its house number and the direction after it. */
function typedStreet(value: string): { number: string; dir: string } {
  const line = value.split(",")[0].trim();
  const m = /^(\d+[a-z]?(?:[-/]\d+[a-z]?)?)\s+(.*)$/i.exec(line);
  if (!m) return { number: "", dir: "" };
  const d = DIRECTION.exec(m[2]);
  return { number: m[1], dir: d ? d[1] : "" };
}

/** A suggestion reconciled with what was typed — or null when it names a
 *  different door or a street running the other way. */
function reconcile(
  p: PhotonProps,
  typed: { number: string; dir: string },
): { address1: string; zip: string; house: boolean } | null {
  let street = (p.street ?? p.name ?? "").split(",")[0].trim();
  if (!street) return null;
  const house = (p.housenumber ?? "").trim();
  if (typed.number && house && house.toLowerCase() !== typed.number.toLowerCase()) return null;
  const typedDir = typed.dir ? DIR_KEY[typed.dir.toLowerCase()] : null;
  const found = DIRECTION.exec(street);
  const foundDir = found ? DIR_KEY[found[1].toLowerCase()] : null;
  if (typedDir && foundDir && typedDir !== foundDir) return null;
  // the direction the map left off stays, as typed
  if (typedDir && !foundDir) street = `${typed.dir} ${street}`;
  const number = house || typed.number;
  return {
    address1: number ? `${number} ${street}` : street,
    // a street without a door spans several ZIPs: never guess theirs
    zip: house ? (p.postcode ?? "") : "",
    house: !!house,
  };
}

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
  // One Google session per address: renewed after every pick.
  const session = useRef(newSession());
  const [fromGoogle, setFromGoogle] = useState(false);
  const latestValue = useRef(value);
  latestValue.current = value;
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
        const g = await googleSuggest(value, session.current).catch(() => null);
        if (id !== reqId.current) return;
        if (g) {
          setSugs(g);
          setFromGoogle(true);
          setActive(-1);
          setOpen(g.length > 0);
          return;
        }
        const r = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(value)}&limit=8&lang=en&layer=house&layer=street&bbox=${US_BBOX}`,
        );
        if (!r.ok || id !== reqId.current) return;
        const j = await r.json();
        const typed = typedStreet(value);
        const out: (Suggestion & { house: boolean })[] = [];
        for (const f of j.features ?? []) {
          const p: PhotonProps = f.properties ?? {};
          if (p.countrycode !== "US") continue;
          const s = reconcile(p, typed);
          const city = p.city ?? p.town ?? p.village ?? p.district ?? "";
          const province = STATE_CODES[p.state ?? ""] ?? "";
          if (!s || !city || !province) continue;
          const label = `${s.address1}, ${city}, ${province}${s.zip ? ` ${s.zip}` : ""}`;
          if (out.some((x) => x.label === label)) continue;
          out.push({
            label,
            address1: s.address1,
            city,
            province,
            zip: s.zip,
            house: s.house,
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
        setFromGoogle(false);
        setActive(-1);
        setOpen(list.length > 0);
      } catch {
        // service hiccup — plain typing is unaffected
      }
    }, 300);
    return () => window.clearTimeout(timer.current);
  }, [value]);

  useEffect(() => () => window.clearTimeout(closeTimer.current), []);

  const choose = async (s: Suggestion) => {
    window.clearTimeout(closeTimer.current);
    setOpen(false);
    setSugs([]);
    setActive(-1);
    if (!s.placeId) {
      picked.current = s.address1;
      onPick(s);
      return;
    }
    // Google: the address parts come with the pick (which also closes the
    // billed session). A typed line that changed meanwhile wins; a failed
    // lookup leaves what was typed alone.
    const typedAt = value;
    const a = await googleDetails(s, session.current, typedStreet(value));
    session.current = newSession();
    if (!a || typedAt !== latestValue.current) return;
    picked.current = a.address1;
    onPick(a);
  };

  // A list from before the house number changed (the new answer still on
  // its way) never shows: picking it would put in a different address.
  const typedNumber = typedStreet(value).number.toLowerCase();
  const shown = typedNumber
    ? sugs.filter((s) => s.address1.toLowerCase().startsWith(`${typedNumber} `))
    : sugs;
  const listOpen = open && shown.length > 0;

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
          aria-expanded={listOpen}
          aria-controls={listId}
          aria-activedescendant={
            listOpen && active >= 0 && shown[active] ? `${listId}-${active}` : undefined
          }
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${inputId}-err` : undefined}
          onChange={(e) => {
            picked.current = null;
            onChange(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              if (!shown.length) return;
              e.preventDefault();
              if (!open) {
                setOpen(true);
                setActive(0);
              } else {
                setActive((a) => (a + 1) % shown.length);
              }
            } else if (e.key === "ArrowUp") {
              if (!listOpen) return;
              e.preventDefault();
              setActive((a) => (a <= 0 ? shown.length - 1 : a - 1));
            } else if (e.key === "Enter") {
              if (listOpen && active >= 0 && shown[active]) {
                e.preventDefault();
                choose(shown[active]);
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
            if (shown.length > 0 && value !== picked.current) setOpen(true);
          }}
        />
        <label htmlFor={inputId}>{label}</label>
        {listOpen && (
          <ul
            className="addr-sugs"
            role="listbox"
            id={listId}
            aria-label="Address suggestions"
          >
            {shown.map((s, i) => (
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
            {/* Google's terms: suggestions shown without a map credit
                "Google Maps" (exact wording). */}
            {fromGoogle && (
              <li role="presentation" className="addr-credit" aria-hidden="true">
                Google Maps
              </li>
            )}
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
