/**
 * ~200-char preview of a review body, cut at a word break. Plain text in,
 * plain text out — bodies are user-generated and only ever JSX-escaped. Cuts
 * on code points so an emoji at the boundary can't leave a lone surrogate.
 * (Same rule as v1's home strip.)
 */
export function clipText(s: string, max = 200): string {
  const points = [...s];
  if (points.length <= max) return s;
  const cut = points.slice(0, max).join("");
  return `${(cut.replace(/\s+\S*$/, "") || cut).trimEnd()}…`;
}

/**
 * The rating's scope label, readable after the number: "4.8 across all
 * Piñatagrams" (the hub sends "Across all Piñatagrams"). Other labels keep
 * their own casing behind a separator — the label always travels with the
 * number, whatever it says.
 */
export function scopeText(label: string): string {
  return /^Across\b/.test(label) ? `a${label.slice(1)}` : `· ${label}`;
}
