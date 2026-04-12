/**
 * Resolves Stripe price IDs for Elevate packs from the user's existing
 * Stripe account (AUD prices only). Never creates products or prices — only
 * looks them up.
 *
 * Matching strategy (in order of preference):
 *  1. lookup_key  — if the user set one matching our key
 *  2. unit_amount — picks the first active, one-time AUD price at the exact cent amount
 *
 * Price IDs are cached in memory for the server's lifetime.
 *
 * NOTE: Checkout sessions use inline price_data with currency: "aud" and do
 * not depend on these resolved IDs. This module is used for monitoring only.
 */

import { getUncachableStripeClient } from "./stripeClient";

type PackPriceIds = Record<string, string>; // packId → Stripe price ID

let cachedPriceIds: PackPriceIds | null = null;

const PACK_DEFINITIONS = [
  { packId: "elevate-1",     unitAmount: 999,  lookupKey: "lulou_elevate_1",    label: "Elevate (A$9.99)" },
  { packId: "elevate-3",     unitAmount: 2699, lookupKey: "lulou_elevate_3",    label: "Elevate Pack 3 (A$26.99)" },
  { packId: "elevate-5",     unitAmount: 3999, lookupKey: "lulou_elevate_5",    label: "Elevate Pack 5 (A$39.99)" },
  { packId: "super-elevate", unitAmount: 3499, lookupKey: "lulou_super_elevate", label: "Super Elevate (A$34.99)" },
] as const;

async function resolveAllPriceIds(): Promise<PackPriceIds> {
  const stripe = await getUncachableStripeClient();

  // ── Step 1: bulk-fetch all active AUD one-time prices ──
  const allPrices: import("stripe").Stripe.Price[] = [];
  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const page = await stripe.prices.list({
      active: true,
      type: "one_time",
      currency: "aud",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    allPrices.push(...page.data);
    hasMore = page.has_more;
    startingAfter = page.data[page.data.length - 1]?.id;
  }

  console.log(`[STRIPE] Found ${allPrices.length} active AUD one-time price(s) in account`);

  // ── Step 2: also try fetching by lookup_key ──
  const lookupKeys = PACK_DEFINITIONS.map(d => d.lookupKey);
  let lookupKeyPrices: import("stripe").Stripe.Price[] = [];
  try {
    const result = await stripe.prices.list({ lookup_keys: lookupKeys, active: true, limit: 100 });
    lookupKeyPrices = result.data.filter(p => p.currency === "aud");
  } catch {
    // Non-fatal
  }

  // Build a map: lookupKey → priceId
  const byLookupKey: Record<string, string> = {};
  for (const p of lookupKeyPrices) {
    if (p.lookup_key) byLookupKey[p.lookup_key] = p.id;
  }

  // Build a map: unitAmount → first matching AUD priceId
  const byAmount: Record<number, string> = {};
  for (const p of allPrices) {
    if (p.unit_amount !== null && !(p.unit_amount in byAmount)) {
      byAmount[p.unit_amount] = p.id;
    }
  }

  const result: PackPriceIds = {};

  for (const def of PACK_DEFINITIONS) {
    const priceId = byLookupKey[def.lookupKey] ?? byAmount[def.unitAmount];

    if (priceId) {
      result[def.packId] = priceId;
      console.log(`[STRIPE] ${def.label} → ${priceId}`);
    } else {
      console.warn(
        `[STRIPE] No AUD price found for ${def.label}. ` +
        `Expected unit_amount=${def.unitAmount} (cents) with currency=aud or lookup_key="${def.lookupKey}". ` +
        `Checkout uses inline price_data so this does not affect payments.`
      );
    }
  }

  return result;
}

export async function getPriceId(packId: string): Promise<string> {
  if (!cachedPriceIds) {
    cachedPriceIds = await resolveAllPriceIds();
  }
  const id = cachedPriceIds[packId];
  if (!id) throw new Error(`No AUD Stripe price mapped for packId: ${packId}`);
  return id;
}

/** Call at server startup to pre-resolve and cache AUD price IDs (monitoring only). */
export async function warmupStripePrices(): Promise<void> {
  try {
    cachedPriceIds = await resolveAllPriceIds();
    const found = Object.values(cachedPriceIds);
    if (found.length > 0) {
      console.log("[STRIPE] AUD price IDs ready:", found.join(", "));
    } else {
      console.log("[STRIPE] No pre-existing AUD prices found — checkout uses inline price_data (AUD).");
    }
  } catch (err: any) {
    console.warn("[STRIPE] AUD price warmup failed (checkout uses inline price_data so this is non-fatal):", err.message ?? err);
  }
}
