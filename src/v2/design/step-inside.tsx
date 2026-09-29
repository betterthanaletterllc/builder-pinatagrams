"use client";

import Image from "next/image";
import { forwardRef } from "react";
import { fillingAllowsAddon } from "@/lib/flow";
import { formatCents, type HubFilling } from "@/lib/hub";
import { candyFilling } from "../lib/defaults";
import type { V2Addon } from "../lib/types";
import { OptionCard } from "../ui/controls";
import { Callout, StepHeader } from "../ui/feedback";
import s from "./steps.module.css";

/**
 * Step 3 · Inside — "What goes inside?". Candy is already chosen (most
 * orders), pet and dates designs arrive with their own filling. The add-on
 * (Double Candy, on ~46% of orders) keeps the most prominent spot on the
 * screen — and is NEVER pre-checked. Fillings that fill the whole box say
 * why no add-on follows.
 */
const StepInside = forwardRef<
  HTMLHeadingElement,
  {
    fillings: HubFilling[];
    addons: V2Addon[];
    filling: string;
    selectedAddons: string[];
    onFilling: (f: HubFilling) => void;
    onAddon: (id: string, on: boolean) => void;
    notice: string | null;
  }
>(function StepInside(p, h1Ref) {
  const candy = candyFilling(p.fillings);
  const rec = p.fillings.find((f) => f.label === p.filling);
  // Every filling shows — none hide behind a "more" link.
  const offered = p.addons.filter((a) => fillingAllowsAddon(rec, a.id));

  return (
    <div>
      <StepHeader ref={h1Ref} index={2} title="What goes inside?" />
      <fieldset className={s.options}>
        <legend className={s.srOnly}>Filling</legend>
        {p.fillings.map((f) => (
          <OptionCard
            key={f.id}
            name="pg-filling"
            value={f.id}
            checked={p.filling === f.label}
            onChange={() => p.onFilling(f)}
            title={f.label}
            badge={f.id === candy?.id ? "Most popular" : undefined}
            description={f.blurb || undefined}
            aside={f.priceCents > 0 ? `+${formatCents(f.priceCents)}` : "Included"}
            media={
              f.imageUrl ? (
                <Image src={f.imageUrl} alt="" width={112} height={112} sizes="56px" />
              ) : undefined
            }
          />
        ))}
      </fieldset>

      {offered.length > 0 && (
        <div className={s.block}>
          <p className={s.eyebrow}>Make it extra</p>
          <div className={s.options}>
            {offered.map((a) => (
              <OptionCard
                key={a.id}
                type="checkbox"
                name={`pg-addon-${a.id}`}
                value={a.id}
                checked={p.selectedAddons.includes(a.id)}
                onChange={(e) => p.onAddon(a.id, e.target.checked)}
                prominent
                title={a.id === "double-candy" ? `Make it ${a.label}` : a.label}
                description={
                  a.blurb || (a.id === "double-candy" ? "Twice the candy, same box" : undefined)
                }
                aside={`+${formatCents(a.priceCents)}`}
                mediaSize={64}
                media={
                  a.imageUrl ? (
                    <Image src={a.imageUrl} alt="" width={128} height={128} sizes="64px" />
                  ) : undefined
                }
              />
            ))}
          </div>
        </div>
      )}
      {p.addons.length > 0 && rec?.addons === "none" && (
        <p className={s.small}>
          Add-ons aren&apos;t available with {rec.label} — it fills the whole box.
        </p>
      )}
      {p.notice && (
        <div className={s.block}>
          <Callout tone="info" role="status">
            {p.notice}
          </Callout>
        </div>
      )}
    </div>
  );
});

export default StepInside;
