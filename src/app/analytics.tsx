"use client";

import Script from "next/script";
import { usePathname } from "next/navigation";
import { useReportWebVitals } from "next/web-vitals";
import { useEffect, useRef, useState } from "react";
import {
  analyticsEnabled,
  GA_ID,
  META_PIXEL_ID,
  reportWebVitals,
  startAnalytics,
  superProps,
  trackPageView,
} from "@/lib/analytics";

/** GA4 + Meta pixel + PostHog bootstrap, SPA page views and web vitals.
 *  Renders nothing — and loads no third-party script — off production
 *  *.pinatagrams.com hosts (lib/analytics analyticsEnabled). PostHog itself
 *  is lazy-loaded by lib/analytics. */
export default function Analytics() {
  const pathname = usePathname();
  const first = useRef(true);
  const [enabled, setEnabled] = useState(false);

  useReportWebVitals(reportWebVitals);

  useEffect(() => {
    if (!analyticsEnabled()) return;
    setEnabled(true);
    startAnalytics();
  }, []);

  useEffect(() => {
    // the landing page view comes from the gtag config / pixel snippet
    // below and startAnalytics (PostHog)
    if (first.current) {
      first.current = false;
      return;
    }
    trackPageView(pathname);
  }, [pathname]);

  if (!enabled) return null;
  return (
    <>
      <Script
        src={`https://www.googletagmanager.com/gtag/js?id=${GA_ID}`}
        strategy="afterInteractive"
      />
      {/* 'set' before 'config' so store_host + flow_version ride every hit,
          the automatic landing page_view included. */}
      <Script id="ga4" strategy="afterInteractive">
        {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
window.gtag = gtag;
gtag('js', new Date());
gtag('set', ${JSON.stringify(superProps())});
gtag('config', '${GA_ID}');`}
      </Script>
      {/* disablePushState: every flow step is a history.pushState, and the
          pixel counted each one as a PageView. Route changes are tracked
          once, by trackPageView. */}
      {META_PIXEL_ID && (
        <Script id="meta-pixel" strategy="afterInteractive">
          {`!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,
document,'script','https://connect.facebook.net/en_US/fbevents.js');
fbq.disablePushState = true;
fbq('init', '${META_PIXEL_ID}');
fbq('track', 'PageView');`}
        </Script>
      )}
    </>
  );
}
