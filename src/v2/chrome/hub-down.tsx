import { HUB_URL } from "@/lib/hub";
import { Alert } from "../ui/icons";
import s from "./hub-down.module.css";

/** The hub (catalog) is unreachable — say so plainly; nothing is lost. */
export default function HubDown() {
  const isProd = process.env.VERCEL_ENV === "production";
  return (
    <main className={s.wrap}>
      <div className={s.box} role="alert">
        <Alert size={24} />
        <div>
          <h1 className={s.title}>Our builder is taking a quick breather.</h1>
          {isProd ? (
            <p>
              We couldn&apos;t load the piñata catalog just now — please refresh in a
              moment. If it keeps happening,{" "}
              <a href="mailto:nathan@pinatagrams.com">let us know</a> and we&apos;ll sort
              it out.
            </p>
          ) : (
            <p>
              Couldn&apos;t reach the hub at {HUB_URL}. If you&apos;re developing
              locally, start the admin app first: <code>cd ../admin && npm run dev</code>.
            </p>
          )}
        </div>
      </div>
    </main>
  );
}
