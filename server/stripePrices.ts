/**
 * Resolves Stripe price IDs for Elevate packs from the user's existing
 * Stripe account. Never creates products or prices — only looks them up.
 *
 * Matching strategy (in order of preference):
 *  1. lookup_key  — if the user set one matching our key
 *  2. unit_amount — picks the first active, one-time price at the exact cent amount
 *
 * Price IDs are cached in memory for the server's lifetime.
 */

import { getUncachableStripeClient } from "./stripeClient";

type PackPriceIds = Record<string, string>; // packId → Stripe price ID

let cachedPriceIds: PackPriceIds | null = null;

const PACK_DEFINITIONS = [
  { packId: "elevate-1",     unitAmount: 999,  lookupKey: "lulou_elevate_1",    label: "Elevate ($9.99)" },
  { packId: "elevate-3",     unitAmount: 2699, lookupKey: "lulou_elevate_3",    label: "Elevate Pack 3 ($26.99)" },
  { packId: "elevate-5",     unitAmount: 3999, lookupKey: "lulou_elevate_5",    label: "Elevate Pack 5 ($39.99)" },
  { packId: "super-elevate", unitAmount: 3499, lookupKey: "lulou_super_elevate", label: "Super Elevate ($34.99)" },
] as const;

async function resolveAllPriceIds(): Promise<PackPriceIds> {
  const stripe = await getUncachableStripeClient();

  // ── Step 1: bulk-fetch all active prices (expand product so we can log names) ──
  const allPrices: import("stripe").Stripe.Price[] = [];
  let hasMore = true;
  let startingAfter: string | undefined;

  while (hasMore) {
    const page = await stripe.prices.list({
      active: true,
      type: "one_time",
      limit: 100,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });
    allPrices.push(...page.data);
    hasMore = page.has_more;
    startingAfter = page.data[page.data.length - 1]?.id;
  }

  console.log(`[STRIPE] Found ${allPrices.length} active one-time price(s) in account`);

  // ── Step 2: also try fetching by lookup_key (may exist if we set them earlier) ──
  const lookupKeys = PACK_DEFINITIONS.map(d => d.lookupKey);
  let lookupKeyPrices: import("stripe").Stripe.Price[] = [];
  try {
    const result = await stripe.prices.list({ lookup_keys: lookupKeys, active: true, limit: 100 });
    lookupKeyPrices = result.data;
  } catch {
    // Non-fatal — lookup_key search is a best-effort enhancement
  }

  // Build a map: lookupKey → priceId
  const byLookupKey: Record<string, string> = {};
  for (const p of lookupKeyPrices) {
    if (p.lookup_key) byLookupKey[p.lookup_key] = p.id;
  }

  // Build a map: unitAmount → first matching priceId (from full price list)
  const byAmount: Record<number, string> = {};
  for (const p of allPrices) {
    if (p.unit_amount !== null && !(p.unit_amount in byAmount)) {
      byAmount[p.unit_amount] = p.id;
    }
  }

  const result: PackPriceIds = {};

  for (const def of PACK_DEFINITIONS) {
    // Prefer lookup_key match, fall back to amount match
    const priceId = byLookupKey[def.lookupKey] ?? byAmount[def.unitAmount];

    if (priceId) {
      result[def.packId] = priceId;
      console.log(`[STRIPE] ${def.label} → ${priceId}`);
    } else {
      console.error(
        `[STRIPE] Could not find price for ${def.label}. ` +
        `Expected unit_amount=${def.unitAmount} (cents) or lookup_key="${def.lookupKey}". ` +
        `Available amounts: ${Object.keys(byAmount).join(", ")}`
      );
    }
  }

  const missing = PACK_DEFINITIONS.filter(d => !result[d.packId]).map(d => d.label);
  if (missing.length > 0) {
    throw new Error(`Missing Stripe prices for: ${missing.join(", ")}. Please verify your Stripe dashboard.`);
  }

  return result;
}

export async function getPriceId(packId: string): Promise<string> {
  if (!cachedPriceIds) {
    cachedPriceIds = await resolveAllPriceIds();
  }
  const id = cachedPriceIds[packId];
  if (!id) throw new Error(`No Stripe price mapped for packId: ${packId}`);
  return id;
}

/** Call at server startup to pre-resolve and cache price IDs. */
export async function warmupStripePrices(): Promise<void> {
  try {
    cachedPriceIds = await resolveAllPriceIds();
    console.log("[STRIPE] Price IDs ready:", Object.values(cachedPriceIds).join(", "));
  } catch (err: any) {
    console.warn("[STRIPE] Price warmup failed (will retry on first checkout):", err.message ?? err);
    // Don't rethrow — let the server start; checkout will fail with a clear error
  }
}
