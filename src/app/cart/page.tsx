import CartView from "./cart-view";

export const metadata = { title: "Cart — Piñatagrams Builder" };

export default function CartPage() {
  return (
    <main>
      <h1>Your cart</h1>
      <CartView />
    </main>
  );
}
