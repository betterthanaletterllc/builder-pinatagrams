import type { Metadata } from "next";
import type { ReactNode } from "react";
import Image from "next/image";
import { Poppins } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import logo from "../../public/pinatagrams-logo.png";

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
  title: "Piñatagrams Builder",
  description: "Design your own custom piñata.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className={`${poppins.variable} ${arbotek.variable}`}>
        <header className="topbar">
          <div className="topbar-inner">
            <Image
              src={logo}
              alt="Piñatagrams"
              className="brand-logo"
              priority
            />
            <span className="brand">
              <em>Builder</em>
            </span>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
