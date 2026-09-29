"use client";

import { useId, useState } from "react";
import { saveDiscountCodes } from "@/lib/flow";
import { formatCents, resolveDiscount, type HubDiscount } from "@/lib/hub";
import { Button } from "../ui/controls";
import { TextField } from "../ui/field";
import { Close, Tag } from "../ui/icons";
import s from "./steps.module.css";

export function describeDiscount(d: HubDiscount): string {
  if (d.kind === "shipping") return "free shipping";
  const off = d.type === "percent" ? `${d.value}% off` : `${formatCents(d.value)} off`;
  return d.freeShipping ? `${off} + free shipping` : off;
}

/**
 * "Have a code?" — collapsed until asked for. Codes resolve through the
 * builder's own /api/discount and are stored exactly as the cart stores
 * them (lib/flow), with the cart's rules: at most two, one per kind (an
 * order code + a free-shipping code). Shopify applies the real discount.
 */
export default function DiscountBox({
  discounts,
  onChange,
  notes,
}: {
  discounts: HubDiscount[];
  onChange: (next: HubDiscount[]) => void;
  /** Per-code eligibility notes (below a minimum, over a shipping cap). */
  notes: { code: string; text: string }[];
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const regionId = useId();

  const apply = async () => {
    const c = code.trim().toUpperCase().slice(0, 64);
    if (!c) return setMsg("Enter a code first.");
    if (discounts.some((d) => d.code === c)) return setMsg("That code is already applied.");
    if (discounts.length >= 2) return setMsg("You can use up to two codes.");
    setChecking(true);
    setMsg(null);
    const d = await resolveDiscount(c);
    setChecking(false);
    if (!d) return setMsg("That code isn't valid.");
    if (discounts.some((x) => x.kind === d.kind)) {
      return setMsg(
        d.kind === "shipping"
          ? "You already have a free-shipping code."
          : "You already have an order discount — it only stacks with a free-shipping code.",
      );
    }
    const next = [...discounts, d];
    onChange(next);
    saveDiscountCodes(next.map((x) => x.code));
    setCode("");
  };

  const remove = (c: string) => {
    const next = discounts.filter((d) => d.code !== c);
    onChange(next);
    saveDiscountCodes(next.map((d) => d.code));
    setMsg(null);
  };

  return (
    <div className={s.codes}>
      {discounts.length > 0 && (
        <ul className={s.codeChips} aria-label="Applied codes">
          {discounts.map((d) => {
            const note = notes.find((n) => n.code === d.code);
            return (
              <li key={d.code} className={s.codeChip} data-dim={!!note || undefined}>
                <Tag size={16} />
                <span>
                  {d.code} · {describeDiscount(d)}
                </span>
                <button type="button" onClick={() => remove(d.code)} aria-label={`Remove code ${d.code}`}>
                  <Close size={16} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {notes.map((n) => (
        <p key={n.code} className={s.small}>
          {n.text}
        </p>
      ))}
      {discounts.length < 2 && (
        <>
          <button
            type="button"
            className={s.linkBtn}
            aria-expanded={open}
            aria-controls={regionId}
            onClick={() => setOpen((o) => !o)}
          >
            {discounts.length ? "Add another code" : "Have a code?"}
          </button>
          <div id={regionId} hidden={!open}>
            <div className={s.codeForm}>
              <TextField
                label="Discount code"
                value={code}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={64}
                error={msg}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void apply();
                  }
                }}
              />
              <Button
                variant="secondary"
                className={s.codeApply}
                busy={checking}
                onClick={() => void apply()}
              >
                Apply
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
