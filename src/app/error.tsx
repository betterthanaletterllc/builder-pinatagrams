"use client";

import { startTransition } from "react";
import { useRouter } from "next/navigation";
import ErrorScreen from "./error-screen";

/** A page (or anything under the root layout) crashed: header and footer
 *  stay, the page area shows a friendly way out. */
export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();
  return (
    <main>
      <ErrorScreen
        error={error}
        boundary="route"
        // re-run the server render too (a hub blip is the likeliest
        // cause), then re-mount the crashed segment
        onRetry={() =>
          startTransition(() => {
            router.refresh();
            reset();
          })
        }
      />
    </main>
  );
}
