"use client";

import "./globals.css";
import ErrorScreen from "./error-screen";

/** The root layout itself crashed, so this replaces the whole document —
 *  no header, footer or fonts from the layout. A full reload is the only
 *  reliable retry at this level. */
export default function GlobalError({
  error,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="en">
      <body>
        <main>
          <ErrorScreen
            error={error}
            boundary="global"
            onRetry={() => window.location.reload()}
          />
        </main>
      </body>
    </html>
  );
}
