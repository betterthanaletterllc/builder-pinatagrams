import Link from "next/link";
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  ChangeEvent,
  ReactNode,
  Ref,
} from "react";
import { Check, Spinner } from "./icons";
import u from "./ui.module.css";

/**
 * v2 controls. No hooks and no "use client": server pages (home) render the
 * link variants, client steps pass handlers. Every selection control is a
 * REAL input or a real toggle button — never a styled div.
 */

type Variant = "primary" | "secondary" | "link";
type Size = "md" | "lg" | "sm";

function btnClass(variant: Variant, size: Size, block?: boolean, extra?: string) {
  return [
    u.btn,
    variant === "primary" ? u.primary : variant === "secondary" ? u.secondary : u.link,
    size === "lg" ? u.lg : size === "sm" ? u.sm : "",
    block ? u.block : "",
    extra ?? "",
  ]
    .filter(Boolean)
    .join(" ");
}

export function Button({
  variant = "primary",
  size = "md",
  block,
  busy,
  className,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  /** Shows a spinner and marks the button busy (the caller still guards
   *  against double submits). */
  busy?: boolean;
}) {
  return (
    <button
      type={type}
      className={btnClass(variant, size, block, `${busy ? u.busy : ""} ${className ?? ""}`)}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <Spinner size={18} className={u.spin} />}
      {children}
    </button>
  );
}

export function ButtonLink({
  href,
  variant = "primary",
  size = "md",
  block,
  className,
  children,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & {
  href: string;
  variant?: Variant;
  size?: Size;
  block?: boolean;
}) {
  // External destinations (the corporate hub) get a plain anchor.
  if (/^https?:/.test(href)) {
    return (
      <a href={href} className={btnClass(variant, size, block, className)} {...rest}>
        {children}
      </a>
    );
  }
  return (
    <Link href={href} className={btnClass(variant, size, block, className)} {...rest}>
      {children}
    </Link>
  );
}

/** A toggle chip: 36px visual, 44px hit area, aria-pressed. */
export function Chip({
  pressed,
  onClick,
  children,
  className,
  ...rest
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "onClick"> & {
  pressed: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`${u.chip} ${className ?? ""}`}
      aria-pressed={pressed}
      onClick={onClick}
      {...rest}
    >
      {children}
    </button>
  );
}

/** A chip-styled navigation link (home occasion shortcuts). */
export function ChipLink({
  href,
  children,
  className,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  return (
    <Link href={href} className={`${u.chip} ${className ?? ""}`} {...rest}>
      {children}
    </Link>
  );
}

/**
 * OptionCard: a <label> wrapping a real, visually hidden radio or checkbox.
 * Selected = periwinkle border + tint + filled mark (the mark pops on
 * select). A disabled option says WHY instead of silently greying out.
 */
export function OptionCard({
  type = "radio",
  name,
  value,
  checked,
  onChange,
  title,
  description,
  aside,
  media,
  mediaSize,
  badge,
  disabled,
  disabledReason,
  describedBy,
  className,
  inputRef,
  inputId,
  prominent,
}: {
  type?: "radio" | "checkbox";
  name: string;
  value: string;
  checked: boolean;
  onChange: (e: ChangeEvent<HTMLInputElement>) => void;
  title: ReactNode;
  description?: ReactNode;
  aside?: ReactNode;
  media?: ReactNode;
  /** Media square in px (default 56). */
  mediaSize?: number;
  badge?: string;
  disabled?: boolean;
  disabledReason?: string;
  describedBy?: string;
  className?: string;
  inputRef?: Ref<HTMLInputElement>;
  /** id on the real input (so a validation pass can focus it). */
  inputId?: string;
  /** A heavier edge for the one offer that must never be missed. */
  prominent?: boolean;
}) {
  return (
    <label
      className={`${u.option} ${prominent ? u.prominent : ""} ${className ?? ""}`}
      data-selected={checked}
      data-disabled={disabled || undefined}
    >
      <input
        ref={inputRef}
        id={inputId}
        className={u.optionInput}
        type={type}
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        aria-describedby={describedBy}
      />
      <span className={`${u.mark} ${type === "checkbox" ? u.markBox : ""}`} aria-hidden="true">
        {type === "checkbox" && checked && <Check size={14} />}
      </span>
      {media && (
        <span
          className={u.optionMedia}
          style={mediaSize ? { width: mediaSize, height: mediaSize } : undefined}
        >
          {media}
        </span>
      )}
      <span className={u.optionBody}>
        <span className={u.optionTitle}>
          {title}
          {badge && <span className={u.badge}>{badge}</span>}
        </span>
        {description && <span className={u.optionDesc}>{description}</span>}
        {disabled && disabledReason && (
          <span className={u.optionWhy}>{disabledReason}</span>
        )}
      </span>
      {aside && <span className={u.optionAside}>{aside}</span>}
    </label>
  );
}
