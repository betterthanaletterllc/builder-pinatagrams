import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { flowFromHeaders } from "@/lib/flow-version";
import CartView from "./cart-view";

export const metadata = { title: "Cart — Piñatagrams Builder" };

export default async function CartPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // The four-step builder (v2) keeps the order on its last step: old /cart
  // links — bookmarks, emails, the sunset v1 flow — land there, their query
  // (a discount code, UTMs) kept.
  if (flowFromHeaders(await headers()) === "v2") {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(await searchParams)) {
      for (const one of [v].flat()) if (one != null) q.append(k, one);
    }
    q.set("step", "deliver");
    redirect(`/design?${q}`);
  }
  return (
    <main>
      <h1>Your cart</h1>
      <CartView />
    </main>
  );
}
