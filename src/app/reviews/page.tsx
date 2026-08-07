import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getReviews } from "@/lib/hub";
import Stars from "../stars";
import MediaGallery from "./media-gallery";

export const metadata: Metadata = {
  title: "Customer reviews — Piñatagrams",
  description:
    "Verified reviews and photos from real Piñatagrams orders — see why senders call it the sweetest gift.",
};

// 24 per page: fills the wall's 2–3 columns evenly, well under the hub's
// 100-per-request cap.
const PER_PAGE = 24;

/**
 * The "see all reviews" explore surface. Server-rendered against the hub's
 * public reviews API: ?page=N maps to limit/offset, so every page is a plain
 * shareable URL and pagination is just links. Review text is USER-GENERATED —
 * everything renders as JSX-escaped text, never HTML. The only client bit is
 * the per-review media lightbox.
 */
export default async function ReviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>;
}) {
  const raw = Math.trunc(Number((await searchParams).page));
  const page = Number.isFinite(raw) && raw > 1 ? raw : 1;
  const data = await getReviews({
    limit: PER_PAGE,
    offset: (page - 1) * PER_PAGE,
  });

  if (!data) {
    return (
      <main>
        <p className="reviews-head-back">
          <Link href="/" className="reviews-back">
            ← Back to the builder
          </Link>
        </p>
        <div className="error-box">
          <strong>Reviews are taking a quick breather.</strong>
          <p className="note">
            We couldn&apos;t load reviews just now — please refresh in a moment.
          </p>
        </div>
      </main>
    );
  }

  // aggregate.count is the WHOLE corpus, so it also sizes the pager. A stale
  // deep link past the end lands on the last real page.
  const totalPages = Math.max(1, Math.ceil(data.aggregate.count / PER_PAGE));
  if (page > totalPages) {
    redirect(totalPages > 1 ? `/reviews?page=${totalPages}` : "/reviews");
  }
  const prevHref = page - 1 > 1 ? `/reviews?page=${page - 1}` : "/reviews";
  const nextHref = `/reviews?page=${page + 1}`;

  return (
    <main>
      <p className="reviews-head-back">
        <Link href="/" className="reviews-back">
          ← Back to the builder
        </Link>
      </p>
      <h1>Customer reviews</h1>
      <p className="reviews-agg">
        <Stars rating={data.aggregate.rating} />
        <span className="reviews-agg-num">
          {data.aggregate.rating.toFixed(1)} ·{" "}
          {data.aggregate.count.toLocaleString("en-US")} reviews
        </span>
        {/* brand-pooled rating — the scope label stays with the number */}
        <span className="reviews-agg-scope">{data.scope.label}</span>
      </p>

      {data.reviews.length === 0 ? (
        <p className="note">No reviews yet.</p>
      ) : (
        <div className="reviews-wall">
          {data.reviews.map((r) => {
            const date = new Date(r.createdAt).toLocaleDateString("en-US", {
              month: "short",
              year: "numeric",
            });
            return (
              <article className="review-card" key={r.id}>
                <div className="review-top">
                  <Stars rating={r.rating} />
                  {r.verified && (
                    <span className="review-badge">Verified buyer</span>
                  )}
                </div>
                {r.title && <strong className="review-title">{r.title}</strong>}
                {/* full body — the explore page never clips */}
                <p className="review-body review-body-full">{r.body}</p>
                <MediaGallery media={r.media ?? []} reviewer={r.name} />
                {/* provenance for the pooled corpus: what was actually
                    bought; nothing when unknown, never a generic name */}
                {r.purchased?.title && (
                  <p className="review-purchased">
                    Purchased: {r.purchased.title}
                  </p>
                )}
                {r.reply && (
                  <div className="review-reply">
                    <span className="review-reply-label">
                      Response from Piñatagrams
                    </span>
                    <p className="review-reply-body">{r.reply}</p>
                  </div>
                )}
                <footer className="review-foot">
                  <span className="review-name">
                    {r.name} · {date}
                  </span>
                  {/* FTC disclosure — must be visible on incentivized
                      reviews wherever they render */}
                  {r.incentivized && (
                    <span className="review-badge incentivized">
                      Received a reward for this review
                    </span>
                  )}
                </footer>
              </article>
            );
          })}
        </div>
      )}

      {totalPages > 1 && (
        <nav className="pager" aria-label="Review pages">
          {page > 1 ? (
            <Link className="pager-btn" href={prevHref}>
              ← Newer
            </Link>
          ) : (
            <span className="pager-btn disabled" aria-disabled="true">
              ← Newer
            </span>
          )}
          <span className="pager-status">
            Page {page} of {totalPages}
          </span>
          {page < totalPages ? (
            <Link className="pager-btn" href={nextHref}>
              Older →
            </Link>
          ) : (
            <span className="pager-btn disabled" aria-disabled="true">
              Older →
            </span>
          )}
        </nav>
      )}
    </main>
  );
}
