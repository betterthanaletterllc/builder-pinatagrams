/**
 * A small brand-colour confetti burst from a point (the button that earned
 * it): "Continue to payment" and "+ Add another piñata" only. Built with the
 * Web Animations API on throwaway, inline-styled nodes — no CSS to leak, no
 * library, nothing left behind. Skipped entirely under reduced motion.
 */

const COLORS = ["#627ae3", "#f6de6b", "#f2a7b0", "#eb7c57", "#55a871", "#180d38"];

export function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

export function confettiBurst(from?: Element | null, pieces = 26): void {
  if (typeof window === "undefined" || prefersReducedMotion()) return;
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  Object.assign(layer.style, {
    position: "fixed",
    inset: "0",
    pointerEvents: "none",
    zIndex: "80",
    overflow: "hidden",
  } satisfies Partial<CSSStyleDeclaration>);
  const r = from?.getBoundingClientRect();
  const x0 = r ? r.left + r.width / 2 : window.innerWidth / 2;
  const y0 = r ? r.top + r.height / 2 : window.innerHeight * 0.7;
  let pending = pieces;
  for (let i = 0; i < pieces; i++) {
    const bit = document.createElement("span");
    const w = 6 + Math.random() * 5;
    Object.assign(bit.style, {
      position: "absolute",
      left: `${x0}px`,
      top: `${y0}px`,
      width: `${w}px`,
      height: `${w * (0.5 + Math.random() * 0.8)}px`,
      background: COLORS[i % COLORS.length],
      borderRadius: Math.random() < 0.35 ? "50%" : "2px",
    } satisfies Partial<CSSStyleDeclaration>);
    layer.appendChild(bit);
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.1;
    const dist = 90 + Math.random() * 130;
    const dx = Math.cos(angle) * dist;
    const dy = Math.sin(angle) * dist;
    const anim = bit.animate(
      [
        { transform: "translate(-50%, -50%) rotate(0deg)", opacity: 1 },
        {
          transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) rotate(${Math.random() * 540 - 270}deg)`,
          opacity: 1,
          offset: 0.55,
        },
        {
          transform: `translate(calc(-50% + ${dx * 1.15}px), calc(-50% + ${dy + 160}px)) rotate(${Math.random() * 720 - 360}deg)`,
          opacity: 0,
        },
      ],
      { duration: 850 + Math.random() * 350, easing: "cubic-bezier(.2,.7,.3,1)" },
    );
    anim.onfinish = () => {
      pending -= 1;
      if (pending === 0) layer.remove();
    };
  }
  document.body.appendChild(layer);
  // Belt and braces: a throttled background tab may never finish animations.
  window.setTimeout(() => layer.remove(), 2500);
}
