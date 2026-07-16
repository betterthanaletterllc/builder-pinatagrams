/**
 * Minimal Shopify Admin GraphQL client for the builder's server routes. Mints
 * a short-lived client-credentials token per call (the same grant the checkout
 * route uses). Returns null when creds aren't configured (e.g. local dev), so
 * callers can degrade gracefully instead of erroring.
 */

const API_VERSION = "2025-01";

export type ShopifyGql = <T = unknown>(
  query: string,
  variables?: Record<string, unknown>,
) => Promise<T>;

export async function shopifyAdmin(): Promise<ShopifyGql | null> {
  const shop = process.env.SHOPIFY_SHOP;
  const clientId = process.env.SHOPIFY_CLIENT_ID;
  const clientSecret = process.env.SHOPIFY_CLIENT_SECRET;
  if (!shop || !clientId || !clientSecret) return null;

  const tokenRes = await fetch(
    `https://${shop}.myshopify.com/admin/oauth/access_token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    },
  );
  if (!tokenRes.ok) throw new Error(`shopify auth failed: ${tokenRes.status}`);
  const { access_token } = await tokenRes.json();

  const url = `https://${shop}.myshopify.com/admin/api/${API_VERSION}/graphql.json`;
  const headers = {
    "Content-Type": "application/json",
    "X-Shopify-Access-Token": access_token as string,
  };

  return async <T>(query: string, variables?: Record<string, unknown>) => {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`shopify gql ${res.status}`);
    const json = await res.json();
    if (json.errors) {
      throw new Error(`shopify gql errors: ${JSON.stringify(json.errors)}`);
    }
    return json.data as T;
  };
}
