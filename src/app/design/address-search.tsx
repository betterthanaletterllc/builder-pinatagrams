"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Shopify-checkout-style address autocomplete: the Address field ITSELF
 * suggests as you type — pick one and street/city/state/ZIP fill in.
 * Backed by Photon (OpenStreetMap's geocoder) — free, keyless, CORS-open;
 * results filter to US and need a street + city + state to be offered.
 * Service down or address unknown → the field is just a normal input.
 * (Upgrade path: swap the fetch for Google Places behind the same UI.)
 */

export type PickedAddress = {
  address1: string;
  city: string;
  province: string;
  zip: string;
};

type Suggestion = PickedAddress & { label: string };

const STATE_CODES: Record<string, string> = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR",
  California: "CA", Colorado: "CO", Connecticut: "CT", Delaware: "DE",
  "District of Columbia": "DC", Florida: "FL", Georgia: "GA", Hawaii: "HI",
  Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA", Kansas: "KS",
  Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD",
  Massachusetts: "MA", Michigan: "MI", Minnesota: "MN", Mississippi: "MS",
  Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV",
  "New Hampshire": "NH", "New Jersey": "NJ", "New Mexico": "NM",
  "New York": "NY", "North Carolina": "NC", "North Dakota": "ND",
  Ohio: "OH", Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA",
  "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD",
  Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA",
  Washington: "WA", "West Virginia": "WV", Wisconsin: "WI", Wyoming: "WY",
};

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
}: {
  value: string;
  onChange: (v: string) => void;
  onPick: (a: PickedAddress) => void;
}) {
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  // After a pick, the field holds the chosen street — don't re-search it.
  const picked = useRef<string | null>(null);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (value.trim().length < 5 || value === picked.current) {
      setSugs([]);
      setOpen(false);
      return;
    }
    timer.current = window.setTimeout(async () => {
      try {
        const r = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(value)}&limit=6&lang=en&layer=house&layer=street`,
        );
        if (!r.ok) return;
        const j = await r.json();
        const out: Suggestion[] = [];
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
          out.push({ label, address1: street, city, province, zip });
        }
        setSugs(out);
        setOpen(out.length > 0);
      } catch {
        // service hiccup — plain typing is unaffected
      }
    }, 300);
    return () => window.clearTimeout(timer.current);
  }, [value]);

  return (
    <div className="field addr-line1">
      <label htmlFor="addr-address1">Address</label>
      <input
        id="addr-address1"
        value={value}
        autoComplete="off"
        placeholder="Start typing — pick the address when it appears"
        onChange={(e) => {
          picked.current = null;
          onChange(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onFocus={() => sugs.length > 0 && value !== picked.current && setOpen(true)}
      />
      {open && (
        <div className="addr-sugs" role="listbox">
          {sugs.map((s) => (
            <button
              key={s.label}
              type="button"
              role="option"
              aria-selected={false}
              className="addr-sug"
              // mousedown beats the input's blur, so the tap always lands
              onMouseDown={(e) => {
                e.preventDefault();
                picked.current = s.address1;
                onPick(s);
                setOpen(false);
                setSugs([]);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
