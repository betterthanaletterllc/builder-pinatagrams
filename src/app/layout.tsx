import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import Image from "next/image";
import { Poppins } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
// The design-system master wordmark. Its <Image> passes sizes= for the
// rendered slot (.brand-logo: 44px tall, 34px on phones → ~82/64px wide) —
// without it Next preloads a 3840px-wide file for a 70-80px logo.
import logo from "../../public/pinatagrams-logo.png";
import CartLink from "./cart-link";
import Analytics from "./analytics";
import DiscountCapture from "./discount-capture";

// Brand fonts per design-system/colors_and_type.css: Arbotek Ultra for
// display/hero titles, Poppins for headings + body.
const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-poppins",
});

// Arbotek styles only a few display elements — not worth preloading 116 KB
// of OTF on every page; they swap in when it arrives.
const arbotek = localFont({
  src: "../fonts/arbotek-ultra.otf",
  variable: "--font-arbotek",
  preload: false,
  display: "swap",
});

export const viewport: Viewport = {
  themeColor: "#f3e7e4",
  // Lets the env(safe-area-inset-*) paddings take effect on notched phones.
  viewportFit: "cover",
};

export const metadata: Metadata = {
  metadataBase: new URL("https://builder.pinatagrams.com"),
  title: "Piñatagrams Builder",
  description:
    "Build a custom Piñatagram — pick a body, design the graphic, add a gift message, and we'll fly it anywhere in the US.",
  openGraph: {
    title: "Piñatagrams Builder",
    description:
      "Design your own custom piñata gift — delivered in a box they'll never forget.",
    siteName: "Piñatagrams",
    // The standard piñata product shot — what a shared link shows.
    images: [
      {
        url: "https://cdn.shopify.com/s/files/1/1116/8788/files/CLASSIC_STANDARD.png?v=1751310452",
        alt: "A classic Piñatagram piñata",
      },
    ],
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${poppins.variable} ${arbotek.variable}`}>
        <Analytics />
        <DiscountCapture />
        <header className="topbar">
          <div className="topbar-inner">
            <a href="/" className="brand-wrap">
              <Image
                src={logo}
                alt="Piñatagrams"
                className="brand-logo"
                priority
                sizes="(max-width: 600px) 64px, 82px"
              />
            </a>
            <CartLink />
          </div>
        </header>
        {children}
        <footer className="site-footer">
          <div className="footer-inner">
            <span>
              © {new Date().getFullYear()} Better Than A Letter LLC ·{" "}
              <a href="https://www.pinatagrams.com">pinatagrams.com</a>
            </span>
            <nav className="footer-links" aria-label="Legal">
              <a href="https://www.pinatagrams.com/policies/terms-of-service">
                Terms of Service
              </a>
              <a href="/terms">Upload Terms</a>
              <a href="https://www.pinatagrams.com/policies/privacy-policy">
                Privacy
              </a>
              <a href="https://www.pinatagrams.com/policies/refund-policy">
                Refunds
              </a>
              <a href="https://www.pinatagrams.com/policies/shipping-policy">
                Shipping
              </a>
              <a href="mailto:nathan@pinatagrams.com">Contact</a>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
