/** Star row (e.g. 4.8 → 96%-wide gold overlay on gray glyphs). Decorative —
 *  the number is always printed beside it, so screen readers skip the stars.
 *  Shared by the home strip and the /reviews explore page. */
export default function Stars({ rating }: { rating: number }) {
  const pct = Math.max(0, Math.min(5, rating)) * 20;
  return (
    <span className="stars" aria-hidden="true">
      <span className="stars-bg">★★★★★</span>
      <span className="stars-fill" style={{ width: `${pct}%` }}>
        ★★★★★
      </span>
    </span>
  );
}
