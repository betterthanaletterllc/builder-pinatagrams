import c from "./chrome.module.css";

/** The v2 site footer — the same legal links as v1, in v2 styling. */
export default function SiteFooterV2() {
  return (
    <footer className={c.footer}>
      <div className={c.footInner}>
        <p>
          © {new Date().getFullYear()} Better Than A Letter LLC ·{" "}
          <a href="https://www.pinatagrams.com">pinatagrams.com</a>
        </p>
        <nav className={c.legal} aria-label="Legal">
          <a href="https://www.pinatagrams.com/policies/terms-of-service">
            Terms of Service
          </a>
          <a href="/terms">Upload Terms</a>
          <a href="https://www.pinatagrams.com/policies/privacy-policy">Privacy</a>
          <a href="https://www.pinatagrams.com/policies/refund-policy">Refunds</a>
          <a href="https://www.pinatagrams.com/policies/shipping-policy">Shipping</a>
          <a href="mailto:nathan@pinatagrams.com">Contact</a>
        </nav>
      </div>
    </footer>
  );
}
