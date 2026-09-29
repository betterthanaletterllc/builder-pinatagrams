import { Star } from "./icons";

/**
 * Five SVG stars filled to the rating (4.8 → 96%). Decorative: the number
 * and its scope label are always printed beside it.
 */
export default function Stars({ rating, size = 16 }: { rating: number; size?: number }) {
  const pct = Math.max(0, Math.min(5, rating)) * 20;
  const row = (color: string) => (
    <span style={{ display: "inline-flex", gap: 1, color }}>
      {Array.from({ length: 5 }, (_, i) => (
        <Star key={i} size={size} />
      ))}
    </span>
  );
  return (
    <span
      aria-hidden="true"
      style={{ position: "relative", display: "inline-flex", lineHeight: 0 }}
    >
      {row("#d9d4de")}
      <span
        style={{
          position: "absolute",
          inset: 0,
          width: `${pct}%`,
          overflow: "hidden",
          whiteSpace: "nowrap",
        }}
      >
        {row("#e0a800")}
      </span>
    </span>
  );
}
