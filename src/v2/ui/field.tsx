"use client";

import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from "react";
import { Alert } from "./icons";
import u from "./ui.module.css";

/**
 * Field: a VISIBLE label, a 16px control (no iOS zoom), an optional hint and
 * an error wired with aria-invalid + aria-describedby. The error text sits
 * right under its control — never in a banner far away.
 */

type Common = {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
};

function useFieldIds(id: string | undefined, hint: unknown, error: unknown) {
  const auto = useId();
  const base = id ?? auto;
  const hintId = hint ? `${base}-hint` : undefined;
  const errorId = error ? `${base}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return { base, hintId, errorId, describedBy };
}

function Shell({
  htmlFor,
  label,
  optional,
  hint,
  hintId,
  error,
  errorId,
  children,
}: Common & {
  htmlFor: string;
  hintId?: string;
  errorId?: string;
  children: ReactNode;
}) {
  return (
    <div className={u.field}>
      <label htmlFor={htmlFor} className={u.label}>
        {label}
        {optional && <span className={u.optional}> (optional)</span>}
      </label>
      {children}
      {error && (
        <p id={errorId} className={u.error} style={{ margin: 0 }}>
          <Alert size={16} />
          <span>{error}</span>
        </p>
      )}
      {hint && (
        <p id={hintId} className={u.hint} style={{ margin: 0 }}>
          {hint}
        </p>
      )}
    </div>
  );
}

export const TextField = forwardRef<
  HTMLInputElement,
  Common & Omit<InputHTMLAttributes<HTMLInputElement>, "children">
>(function TextField({ label, hint, error, optional, id, className, ...rest }, ref) {
  const { base, hintId, errorId, describedBy } = useFieldIds(id, hint, error);
  return (
    <Shell
      htmlFor={base}
      label={label}
      optional={optional}
      hint={hint}
      hintId={hintId}
      error={error}
      errorId={errorId}
    >
      <input
        ref={ref}
        id={base}
        className={`${u.input} ${className ?? ""}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
    </Shell>
  );
});

export const TextArea = forwardRef<
  HTMLTextAreaElement,
  Common & Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "children">
>(function TextArea({ label, hint, error, optional, id, className, ...rest }, ref) {
  const { base, hintId, errorId, describedBy } = useFieldIds(id, hint, error);
  return (
    <Shell
      htmlFor={base}
      label={label}
      optional={optional}
      hint={hint}
      hintId={hintId}
      error={error}
      errorId={errorId}
    >
      <textarea
        ref={ref}
        id={base}
        className={`${u.input} ${className ?? ""}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      />
    </Shell>
  );
});

export const SelectField = forwardRef<
  HTMLSelectElement,
  Common & SelectHTMLAttributes<HTMLSelectElement>
>(function SelectField(
  { label, hint, error, optional, id, className, children, ...rest },
  ref,
) {
  const { base, hintId, errorId, describedBy } = useFieldIds(id, hint, error);
  return (
    <Shell
      htmlFor={base}
      label={label}
      optional={optional}
      hint={hint}
      hintId={hintId}
      error={error}
      errorId={errorId}
    >
      <select
        ref={ref}
        id={base}
        className={`${u.input} ${className ?? ""}`}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...rest}
      >
        {children}
      </select>
    </Shell>
  );
});
