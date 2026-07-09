import type { Metadata } from "next";
import type { ReactNode } from "react";
import Image from "next/image";
import { Poppins } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import logo from "../../public/pinatagrams-logo.png";
import CartLink from "./cart-link";
import Analytics from "./analytics";

// Brand fonts per design-system/colors_and_type.css: Arbotek Ultra for
// display/hero titles, Poppins for headings + body.
const poppins = Poppins({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-poppins",
});

const arbotek = localFont({
  src: "../fonts/arbotek-ultra.otf",
  variable: "--font-arbotek",
});

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
        <header className="topbar">
          <div className="topbar-inner">
            <a href="/" className="brand-wrap">
              <Image
                src={logo}
                alt="Piñatagrams"
                className="brand-logo"
                priority
              />
              <span className="brand">
                <em>Builder</em>
              </span>
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
