"use client";

import { useEffect } from "react";
import { track } from "@/lib/analytics";
import { rememberPreviewVariant, variantUnresolved } from "@/lib/variant";

/**
 * Invisible variant bookkeeping, mounted by the server pages:
 * - keeps a non-production ?variant= preview sticky for the sitting so
 *   client-only surfaces (the cart) preview the same profile;
 * - fires a LOUD analytics event when a hostname resolved to the fallback
 *   unexpectedly — a typo'd hub row or ads running before the profile
 *   exists must never be a silent tiered-vs-tiered "experiment".
 */
export default function VariantBoot({
  variantName,
  resolvedVia,
  preview,
}: {
  variantName: string;
  resolvedVia: "name" | "host" | "fallback";
  preview: boolean;
}) {
  useEffect(() => {
    if (preview) rememberPreviewVariant(variantName);
    const host = window.location.hostname;
    if (variantUnresolved(resolvedVia, host)) {
      track("variant_unresolved", { host });
      console.error(
        `variant: host "${host}" matched no hub profile — serving default. ` +
          "Check admin /pricing → Builder variants before running ads on this URL.",
      );
    }
  }, [variantName, resolvedVia, preview]);
  return null;
}
