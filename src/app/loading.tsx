import s from "./app-states.module.css";

/**
 * Shown the instant a page starts rendering on the server (the hub catalog
 * fetch) — before this, the first tap after picking a body style looked
 * dead until the whole page arrived. Brand-colored placeholders at fixed
 * sizes: a Stage-shaped box and three option cards.
 */
export default function Loading() {
  return (
    <main className={s.skeleton} aria-busy="true">
      <p className="visually-hidden" role="status">
        Loading your piñata…
      </p>
      <div className={s.stage} />
      <div className={s.cards}>
        <div className={s.card} />
        <div className={s.card} />
        <div className={s.card} />
      </div>
    </main>
  );
}
