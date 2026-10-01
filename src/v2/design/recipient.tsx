"use client";

import { useEffect, useId, useRef } from "react";
import AddressLine1, { type PickedAddress } from "@/app/design/address-search";
import type { Carrier } from "@/lib/delivery";
import type { DeliveryAddress } from "@/lib/flow";
import { US_STATES, toStateCode, type AddressErrors, type AddressField } from "../lib/address";
import { OptionCard } from "../ui/controls";
import { Callout } from "../ui/feedback";
import { SelectField, TextField } from "../ui/field";
import { Alert } from "../ui/icons";
import u from "../ui/ui.module.css";
import s from "./steps.module.css";

/** DOM id of each address control, for "focus the first invalid field". */
export const ADDRESS_IDS: Record<AddressField, string> = {
  name: "pg-addr-name",
  address1: "pg-addr-street", // the wrapper; its input is focused
  address2: "pg-addr-address2",
  city: "pg-addr-city",
  province: "pg-addr-province",
  zip: "pg-addr-zip",
  phone: "pg-addr-phone",
};

export function focusAddressField(field: AddressField) {
  const el = document.getElementById(ADDRESS_IDS[field]);
  const target = el instanceof HTMLInputElement || el instanceof HTMLSelectElement
    ? el
    : el?.querySelector("input");
  target?.focus();
}

/**
 * The street field is the shared AddressLine1 (address-search.tsx: type-
 * ahead suggestions that fill street/city/state/ZIP). It's used as-is; this
 * wrapper only adds what the v2 form needs on its input — the recipient
 * autocomplete section, aria-invalid/aria-describedby for the error — and
 * restyles its floating label as a static v2 label (scoped CSS).
 */
function StreetField({
  value,
  error,
  onChange,
  onPick,
  onBlur,
}: {
  value: string;
  error?: string;
  onChange: (v: string) => void;
  onPick: (a: PickedAddress) => void;
  onBlur: () => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const errorId = useId();
  useEffect(() => {
    const input = wrap.current?.querySelector("input");
    if (!input) return;
    input.setAttribute("autocomplete", "section-recipient shipping address-line1");
    if (error) {
      input.setAttribute("aria-invalid", "true");
      input.setAttribute("aria-describedby", errorId);
    } else {
      input.removeAttribute("aria-invalid");
      input.removeAttribute("aria-describedby");
    }
  });
  return (
    <div
      id={ADDRESS_IDS.address1}
      ref={wrap}
      // address suggestions: kept out of autocapture and session replay
      className={`${s.street} ph-sensitive`}
      data-ph-mask
      onBlur={(e) => {
        if (!wrap.current?.contains(e.relatedTarget as Node | null)) onBlur();
      }}
    >
      <AddressLine1 value={value} onChange={onChange} onPick={onPick} />
      {error && (
        <p id={errorId} className={`${u.error} ${s.streetError}`}>
          <Alert size={16} />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}

export function AddressForm({
  address,
  errors,
  carrier,
  onChange,
  onBlurField,
}: {
  address: DeliveryAddress;
  /** Only the errors that should SHOW (touched or after a submit). */
  errors: AddressErrors;
  carrier: Carrier | null;
  onChange: (patch: Partial<DeliveryAddress>) => void;
  onBlurField: (f: AddressField) => void;
}) {
  const field = (f: AddressField) => ({
    id: ADDRESS_IDS[f],
    value: address[f],
    error: errors[f],
    onBlur: () => onBlurField(f),
  });
  return (
    <div className={s.form}>
      <TextField
        {...field("name")}
        label="Recipient's name"
        // Never autofill the BUYER's own name into the recipient.
        autoComplete="off"
        maxLength={80}
        onChange={(e) => onChange({ name: e.target.value })}
      />
      <StreetField
        value={address.address1}
        error={errors.address1}
        onChange={(v) => onChange({ address1: v })}
        onPick={(p) =>
          onChange({
            address1: p.address1,
            city: p.city,
            province: toStateCode(p.province) || p.province,
            // a street-only pick carries no ZIP: keep the one typed
            ...(p.zip ? { zip: p.zip } : {}),
          })
        }
        onBlur={() => onBlurField("address1")}
      />
      <TextField
        {...field("address2")}
        label="Apt / Suite"
        optional
        autoComplete="section-recipient shipping address-line2"
        maxLength={120}
        onChange={(e) => onChange({ address2: e.target.value })}
      />
      <div className={s.addrRow}>
        <div className={s.addrCity}>
          <TextField
            {...field("city")}
            label="City"
            autoComplete="section-recipient shipping address-level2"
            maxLength={60}
            onChange={(e) => onChange({ city: e.target.value })}
          />
        </div>
        <SelectField
          {...field("province")}
          label="State"
          autoComplete="section-recipient shipping address-level1"
          onChange={(e) => onChange({ province: e.target.value })}
        >
          <option value="">Choose…</option>
          {US_STATES.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </SelectField>
        <TextField
          {...field("zip")}
          label="ZIP"
          inputMode="numeric"
          autoComplete="section-recipient shipping postal-code"
          maxLength={10}
          onChange={(e) => onChange({ zip: e.target.value.replace(/[^\d-]/g, "") })}
        />
      </div>
      <TextField
        {...field("phone")}
        label="Phone"
        optional
        type="tel"
        inputMode="tel"
        autoComplete="section-recipient shipping tel"
        maxLength={24}
        hint={
          carrier === "usps"
            ? "Only if the carrier needs to reach them."
            : "Only if FedEx needs to reach them."
        }
        onChange={(e) => onChange({ phone: e.target.value })}
      />
    </div>
  );
}

/**
 * "Who's it for?" — one address per order. With piñatas already in the
 * order, the shopper chooses explicitly: the same recipient (shown, with
 * Change) or someone else, which means a separate order — the order in
 * progress checks out first via the step's primary action (never a silent
 * re-route of earlier piñatas).
 */
export default function Recipient({
  headingId,
  cartAddress,
  cartCount,
  allowSomeoneElse,
  mode,
  onMode,
  editing,
  onEdit,
  address,
  errors,
  carrier,
  onChange,
  onBlurField,
}: {
  headingId: string;
  cartAddress: DeliveryAddress | null;
  cartCount: number;
  /** A new piñata is in progress (not review / not an edit). */
  allowSomeoneElse: boolean;
  mode: "same" | "new";
  onMode: (m: "same" | "new") => void;
  editing: boolean;
  onEdit: () => void;
  address: DeliveryAddress;
  errors: AddressErrors;
  carrier: Carrier | null;
  onChange: (patch: Partial<DeliveryAddress>) => void;
  onBlurField: (f: AddressField) => void;
}) {
  const form = (
    <AddressForm
      address={address}
      errors={errors}
      carrier={carrier}
      onChange={onChange}
      onBlurField={onBlurField}
    />
  );
  if (!cartAddress) return form;

  const summary = (
    // the recipient's address: kept out of autocapture and session replay
    <div className={`${s.recipientCard} ph-sensitive`} data-ph-mask>
      <p>
        <strong>Send to:</strong> {cartAddress.name}
        <br />
        {cartAddress.address1}
        {cartAddress.address2 ? `, ${cartAddress.address2}` : ""}, {cartAddress.city},{" "}
        {cartAddress.province} {cartAddress.zip}
      </p>
      <button type="button" className={s.linkBtn} onClick={onEdit}>
        Change
      </button>
    </div>
  );

  return (
    <>
      {allowSomeoneElse && (
        <fieldset className={`${s.options} ${s.twoUp}`} aria-labelledby={headingId}>
          <OptionCard
            name="pg-recipient"
            value="same"
            checked={mode === "same"}
            onChange={() => onMode("same")}
            title="Same recipient"
            description={
              <span className="ph-sensitive" data-ph-mask>
                {cartAddress.name}, {cartAddress.city} {cartAddress.province}
              </span>
            }
          />
          <OptionCard
            name="pg-recipient"
            value="new"
            checked={mode === "new"}
            onChange={() => onMode("new")}
            title="Someone else"
            description="Sent as its own order"
          />
        </fieldset>
      )}
      {mode === "new" && allowSomeoneElse ? (
        <div className={s.block}>
          <Callout tone="info">
            <p>
              Every order ships to one address, so this one becomes its own order. Pay
              for the {cartCount} piñata{cartCount === 1 ? "" : "s"} already in your order
              first — this one stays saved right here, ready for its new recipient.
            </p>
          </Callout>
        </div>
      ) : editing ? (
        <>
          <p className={s.small}>This updates the address for every piñata in the order.</p>
          {form}
        </>
      ) : (
        summary
      )}
    </>
  );
}
