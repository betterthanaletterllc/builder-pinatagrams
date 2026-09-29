"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import logo from "../../../public/pinatagrams-logo.png";
import CartButton from "./cart-button";
import c from "./chrome.module.css";

/**
 * The v2 site header (logo + live cart). The /design journey renders its
 * own FlowHeader (back · step · progress · cart), so this one steps aside
 * there — decided by pathname on the client, because the root layout does
 * not re-render on client-side navigation.
 */
export default function SiteHeaderV2() {
  const pathname = usePathname();
  if (pathname?.startsWith("/design")) return null;
  return (
    <header className={c.header}>
      <div className={c.inner}>
        <Link href="/" className={c.brand}>
          <Image
            src={logo}
            alt="Piñatagrams"
            className={c.logo}
            sizes="90px"
            loading="eager"
          />
        </Link>
        <CartButton />
      </div>
    </header>
  );
}
