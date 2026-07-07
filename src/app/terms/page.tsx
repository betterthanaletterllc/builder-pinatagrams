import Link from "next/link";

export const metadata = {
  title: "Custom Product & Upload Terms — Piñatagrams Builder",
  robots: { index: false },
};

/**
 * Builder-specific terms covering user uploads and made-to-order products —
 * supplements the store's Terms of Service (linked below), which the stock
 * Shopify template doesn't cover. Plain-English boilerplate: reviewed by
 * the owner; not a substitute for advice of counsel.
 */
export default function TermsPage() {
  return (
    <main className="legal-page">
      <h1>Custom Product &amp; Upload Terms</h1>
      <p className="note">
        These terms apply to designs created at builder.pinatagrams.com and
        supplement the{" "}
        <a href="https://www.pinatagrams.com/policies/terms-of-service">
          Piñatagrams Terms of Service
        </a>{" "}
        and{" "}
        <a href="https://www.pinatagrams.com/policies/privacy-policy">
          Privacy Policy
        </a>
        . By creating or ordering a custom Piñatagram you agree to them.
      </p>

      <h2>Your uploads</h2>
      <p>
        When you upload photos, add text, or design a graphic here
        (&quot;Uploaded Content&quot;), you grant Better Than A Letter LLC a
        non-exclusive, royalty-free license to store, reproduce, print, and
        use that content solely to produce, fulfill, and support your order —
        including sharing it with our production and shipping partners. You
        keep ownership of your content.
      </p>
      <p>
        You promise that you own or have permission to use everything you
        upload, and that it doesn&apos;t violate anyone&apos;s copyright,
        trademark, privacy, or publicity rights. Please don&apos;t upload
        anything unlawful, hateful, obscene, or threatening.
      </p>

      <h2>Our discretion</h2>
      <p>
        We may refuse, cancel, and refund any order whose content we believe
        violates these terms or someone else&apos;s rights, and we may remove
        that content from our systems.
      </p>

      <h2>Made to order</h2>
      <p>
        Custom Piñatagrams are produced specifically for you. Please
        double-check your design — spelling, photos, layout — before
        ordering: we print what you approve on the preview. Returns and
        replacements follow our{" "}
        <a href="https://www.pinatagrams.com/policies/refund-policy">
          Refund Policy
        </a>
        .
      </p>

      <h2>Storage &amp; deletion</h2>
      <p>
        Uploaded Content and design files are stored with our cloud hosting
        providers and retained as needed to fulfill orders, provide reprints
        or replacements, and meet our legal obligations. To request deletion
        of your uploads, email{" "}
        <a href="mailto:support@pinatagrams.com">support@pinatagrams.com</a>.
      </p>

      <p className="note">
        <Link href="/">← Back to the builder</Link>
      </p>
    </main>
  );
}
