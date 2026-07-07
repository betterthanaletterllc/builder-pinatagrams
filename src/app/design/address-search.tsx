"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Live address search: type a few characters, pick the right address, the
 * form below fills itself. Backed by Photon (OpenStreetMap's geocoder) —
 * free, keyless, CORS-open; results filter to US and require a street +
 * city + state before they're offered. If the service is down or the
 * address isn't found, the manual fields below keep working untouched.
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

export default function AddressSearch({
  onPick,
}: {
  onPick: (a: PickedAddress) => void;
}) {
  const [q, setQ] = useState("");
  const [sugs, setSugs] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    window.clearTimeout(timer.current);
    if (q.trim().length < 5) {
      setSugs([]);
      setOpen(false);
      return;
    }
    timer.current = window.setTimeout(async () => {
      try {
        const r = await fetch(
          `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=6&lang=en&layer=house&layer=street`,
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
        // service hiccup — manual entry below is unaffected
      }
    }, 300);
    return () => window.clearTimeout(timer.current);
  }, [q]);

  return (
    <div className="addr-search">
      <input
        type="search"
        className="in addr-search-input"
        placeholder="🔎 Find the address — start typing, then tap it"
        value={q}
        autoComplete="off"
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => sugs.length > 0 && setOpen(true)}
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
              onClick={() => {
                onPick(s);
                setQ(s.label);
                setOpen(false);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <p className="note addr-search-note">
        …or type it in below. Don&apos;t forget the apt/suite if there is one.
      </p>
    </div>
  );
}
