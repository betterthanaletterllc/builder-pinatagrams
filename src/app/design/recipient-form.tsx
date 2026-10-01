"use client";

import { Fragment, useState, type InputHTMLAttributes } from "react";
import type { DeliveryAddress } from "@/lib/flow";
import type { Carrier } from "@/lib/delivery";
import AddressLine1, { stateCode, US_STATES } from "./address-search";

/**
 * The recipient's address — Send-to step and the Delivery step's "Change".
 *
 * Browser-fillable: every field carries a `section-recipient shipping …`
 * autocomplete token (the section keeps the payer's own details out of it).
 * State is a real <select>, ZIP brings up the number pad. Errors show next
 * to their field once it's been left (blur) or when the step's button is
 * tapped — the button stays enabled and the caller focuses the first
 * problem (addressErrors + ADDRESS_FIELD_ORDER).
 */

export type AddressErrors = Partial<Record<keyof DeliveryAddress, string>>;

// Focus order for "take me to the first problem".
export const ADDRESS_FIELD_ORDER: (keyof DeliveryAddress)[] = [
  "name",
  "address1",
  "address2",
  "city",
  "province",
  "zip",
  "phone",
];

// Short names for a one-line "what's missing" summary by the button.
export const ADDRESS_FIELD_NAMES: Record<keyof DeliveryAddress, string> = {
  name: "recipient name",
  address1: "street address",
  address2: "apt / suite",
  city: "city",
  province: "state",
  zip: "ZIP",
  phone: "phone",
};

// "PO Box 12", "P.O. Box", "POB 12", "Post Office Box" — not a street a
// courier can walk up to. Word-bounded so "Poblano St" stays a street.
const PO_BOX_RE = /\b(?:p\.?\s*o\.?\s*b(?:ox)?|post\s+office\s+box)\b/i;
const ZIP_RE = /^\d{5}(?:-?\d{4})?$/;

export function isPoBox(a: Pick<DeliveryAddress, "address1" | "address2">): boolean {
  return PO_BOX_RE.test(a.address1) || PO_BOX_RE.test(a.address2);
}

/** Every problem with the address for this carrier, keyed by field. FedEx
 *  can't deliver to PO boxes; USPS can. */
export function addressErrors(
  a: DeliveryAddress,
  carrier: Carrier,
  uspsOffered: boolean,
): AddressErrors {
  const e: AddressErrors = {};
  const poBoxMsg = uspsOffered
    ? "FedEx can't deliver to PO boxes — use a street address or choose USPS."
    : "FedEx can't deliver to PO boxes — use a street address.";
  if (!a.name.trim()) e.name = "Add the recipient's name.";
  if (!a.address1.trim()) e.address1 = "Add a street address.";
  else if (carrier === "fedex" && PO_BOX_RE.test(a.address1)) e.address1 = poBoxMsg;
  if (carrier === "fedex" && PO_BOX_RE.test(a.address2)) e.address2 = poBoxMsg;
  if (!a.city.trim()) e.city = "Add a city.";
  if (!stateCode(a.province)) e.province = "Pick a state.";
  const zip = a.zip.trim();
  if (!ZIP_RE.test(zip)) {
    e.zip = zip ? "Enter a 5-digit ZIP code." : "Add a ZIP code.";
  }
  const digits = a.phone.replace(/\D/g, "");
  if (a.phone.trim() && (digits.length < 10 || digits.length > 15)) {
    e.phone = "Check the phone number — or leave it blank.";
  }
  return e;
}

/** Move focus to the first field with a problem (returns false if none). */
export function focusFirstAddressError(
  errors: AddressErrors,
  idPrefix = "addr",
): boolean {
  const first = ADDRESS_FIELD_ORDER.find((k) => errors[k]);
  if (!first) return false;
  document.getElementById(`${idPrefix}-${first}`)?.focus();
  return true;
}

/** "Add the recipient name and ZIP." — the summary next to the button. */
export function addressErrorSummary(errors: AddressErrors): string {
  const names = ADDRESS_FIELD_ORDER.filter((k) => errors[k]).map(
    (k) => ADDRESS_FIELD_NAMES[k],
  );
  if (!names.length) return "";
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Check the ${list} — see the highlighted field${names.length === 1 ? "" : "s"}.`;
}

export default function RecipientForm({
  idPrefix = "addr",
  value,
  onChange,
  carrier,
  uspsOffered,
  showAllErrors,
}: {
  idPrefix?: string;
  value: DeliveryAddress;
  onChange: (a: DeliveryAddress) => void;
  carrier: Carrier;
  uspsOffered: boolean;
  // Set once the step's button was tapped: every problem shows, not just
  // the fields already visited.
  showAllErrors: boolean;
}) {
  const [touched, setTouched] = useState<
    Partial<Record<keyof DeliveryAddress, boolean>>
  >({});
  const errors = addressErrors(value, carrier, uspsOffered);
  const shown = (k: keyof DeliveryAddress) =>
    showAllErrors || touched[k] ? errors[k] : undefined;
  const leave = (k: keyof DeliveryAddress) => () =>
    setTouched((t) => (t[k] ? t : { ...t, [k]: true }));
  const set = (k: keyof DeliveryAddress, v: string) =>
    onChange({ ...value, [k]: v });

  const field = (
    k: Exclude<keyof DeliveryAddress, "address1" | "province">,
    label: string,
    attrs: InputHTMLAttributes<HTMLInputElement>,
  ) => {
    const err = shown(k);
    const id = `${idPrefix}-${k}`;
    // The message sits AFTER the field box: the floating label centers on
    // the box, so nothing else may live inside it.
    return (
      <Fragment key={k}>
        <div className={"ffield" + (err ? " invalid" : "")}>
          {/* Shopify-checkout style: the label floats INSIDE the input
              (placeholder=" " keeps :placeholder-shown working). */}
          <input
            id={id}
            placeholder=" "
            value={value[k]}
            onChange={(e) => set(k, e.target.value)}
            onBlur={leave(k)}
            aria-invalid={err ? true : undefined}
            aria-describedby={err ? `${id}-err` : undefined}
            {...attrs}
          />
          <label htmlFor={id}>{label}</label>
        </div>
        {err && (
          <p className="field-err" id={`${id}-err`}>
            {err}
          </p>
        )}
      </Fragment>
    );
  };

  const provinceErr = shown("province");
  const provinceId = `${idPrefix}-province`;

  return (
    <div className="recipient-form">
      {field("name", "Recipient name", {
        autoComplete: "section-recipient shipping name",
        autoCapitalize: "words",
      })}
      {/* The Address field itself suggests as you type; picking fills
          street/city/state/ZIP. */}
      <AddressLine1
        inputId={`${idPrefix}-address1`}
        value={value.address1}
        onChange={(v) => set("address1", v)}
        // a street-only pick carries no ZIP: keep the one typed
        onPick={(picked) => onChange({ ...value, ...picked, zip: picked.zip || value.zip })}
        error={shown("address1")}
        onBlur={leave("address1")}
      />
      {field("address2", "Apt / suite (optional)", {
        autoComplete: "section-recipient shipping address-line2",
      })}
      {field("city", "City", {
        autoComplete: "section-recipient shipping address-level2",
        autoCapitalize: "words",
      })}
      <div
        className={"ffield ffield-select" + (provinceErr ? " invalid" : "")}
      >
        <select
          id={provinceId}
          value={stateCode(value.province)}
          onChange={(e) => set("province", e.target.value)}
          onBlur={leave("province")}
          autoComplete="section-recipient shipping address-level1"
          aria-invalid={provinceErr ? true : undefined}
          aria-describedby={provinceErr ? `${provinceId}-err` : undefined}
        >
          <option value="">Choose a state</option>
          {US_STATES.map(([code, name]) => (
            <option key={code} value={code}>
              {name}
            </option>
          ))}
        </select>
        <label htmlFor={provinceId}>State</label>
      </div>
      {provinceErr && (
        <p className="field-err" id={`${provinceId}-err`}>
          {provinceErr}
        </p>
      )}
      {field("zip", "ZIP", {
        autoComplete: "section-recipient shipping postal-code",
        inputMode: "numeric",
        maxLength: 10,
      })}
      {field("phone", "Phone (optional)", {
        type: "tel",
        autoComplete: "section-recipient shipping tel",
      })}
    </div>
  );
}
