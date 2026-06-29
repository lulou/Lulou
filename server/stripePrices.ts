/**
 * Stripe product/price registry for Lulou (AUD, one-time payments).
 *
 * ensureAllPrices():
 *   Called at server startup. For each registered item:
 *     1. Lists active prices by lookup_key — reuses if found.
 *     2. Creates a Product + Price with the lookup_key if not found.
 *   Idempotent — safe to call on every restart; never creates duplicates.
 *   lookup_key uniqueness is enforced by Stripe (one active price per key).
 *
 * getPriceId(packId):
 *   Returns the cached Stripe price ID. Throws if not resolved — callers
 *   should catch and fall back to inline price_data.
 *
 * tryGetPriceId(packId):
 *   Same but returns null instead of throwing. Use this in checkout routes
 *   so a transient Stripe error never blocks a purchase.
 */

import { getUncachableStripeClient } from "./stripeClient";
import type Stripe from "stripe";

type PriceCache = Record<string, string>; // packId → Stripe price ID

let cachedPriceIds: PriceCache | null = null;

interface PackDefinition {
  packId: string;
  productName: string;
  unitAmount: number;
  lookupKey: string;
  label: string;
}

const PACK_DEFINITIONS: PackDefinition[] = [
  { packId: "sparks-1",          productName: "1 Halo",               unitAmount: 299,  lookupKey: "lulou_sparks_1",          label: "1 Halo (A$2.99)" },
  { packId: "sparks-3",          productName: "3 Halos",              unitAmount: 699,  lookupKey: "lulou_sparks_3",          label: "3 Halos (A$6.99)" },
  { packId: "sparks-5",          productName: "5 Halos",              unitAmount: 999,  lookupKey: "lulou_sparks_5",          label: "5 Halos (A$9.99)" },
  { packId: "voice-notes-unlock",productName: "Voice Notes Unlock",   unitAmount: 499,  lookupKey: "lulou_voice_notes_unlock",label: "Voice Notes Unlock (A$4.99)" },
  { packId: "elevate-1",         productName: "Elevate",              unitAmount: 999,  lookupKey: "lulou_elevate_1",         label: "Elevate (A$9.99)" },
  { packId: "elevate-3",         productName: "Elevate Pack 3",       unitAmount: 2699, lookupKey: "lulou_elevate_3",         label: "Elevate Pack 3 (A$26.99)" },
  { packId: "elevate-5",         productName: "Elevate Pack 5",       unitAmount: 3999, lookupKey: "lulou_elevate_5",         label: "Elevate Pack 5 (A$39.99)" },
  { packId: "super-elevate",     productName: "Super Elevate",        unitAmount: 3499, lookupKey: "lulou_super_elevate",     label: "Super Elevate (A$34.99)" },
];

/**
 * Finds or creates a Stripe price for one pack definition.
 * Uses lookup_key for idempotency — Stripe allows only one active price per key.
 */
async function ensurePrice(stripe: Stripe, def: PackDefinition): Promise<string> {
  const existing = await stripe.prices.list({
    lookup_keys: [def.lookupKey],
    active: true,
    limit: 1,
  });

  if (existing.data.length > 0) {
    const price = existing.data[0];
    console.log(`[STRIPE_PRICES] REUSE  ${def.label} → ${price.id}`);
    return price.id;
  }

  console.log(`[STRIPE_PRICES] CREATE ${def.label} (lookup_key=${def.lookupKey} not found)`);

  const product = await stripe.products.create({
    name: def.productName,
    metadata: { lulou_pack_id: def.packId },
  });

  const price = await stripe.prices.create({
    product: product.id,
    currency: "aud",
    unit_amount: def.unitAmount,
    lookup_key: def.lookupKey,
    metadata: { lulou_pack_id: def.packId },
  });

  console.log(`[STRIPE_PRICES] CREATED ${def.label} → price=${price.id} product=${product.id}`);
  return price.id;
}

/**
 * Resolves (find or create) all registered pack prices.
 * Returns packId → priceId map.
 */
async function resolveAllPriceIds(): Promise<PriceCache> {
  const stripe = getUncachableStripeClient();
  const result: PriceCache = {};
  const errors: string[] = [];

  await Promise.all(
    PACK_DEFINITIONS.map(async (def) => {
      try {
        result[def.packId] = await ensurePrice(stripe, def);
      } catch (err: any) {
        errors.push(`${def.label}: ${err.message}`);
        console.error(`[STRIPE_PRICES] ERROR resolving ${def.label}:`, err.message);
      }
    })
  );

  const resolved = Object.keys(result).length;
  const total = PACK_DEFINITIONS.length;
  console.log(`[STRIPE_PRICES] Ready: ${resolved}/${total} prices resolved${errors.length ? ` (${errors.length} failed)` : ""}`);
  return result;
}

/**
 * Call at server startup. Finds or creates all AUD prices in Stripe.
 * Results are cached for the server's lifetime — no duplicate creates on retry.
 */
export async function warmupStripePrices(): Promise<void> {
  try {
    cachedPriceIds = await resolveAllPriceIds();
    const ids = Object.values(cachedPriceIds);
    if (ids.length > 0) {
      console.log(`[STRIPE_PRICES] ${ids.length} price IDs cached and ready.`);
    }
  } catch (err: any) {
    console.warn("[STRIPE_PRICES] Warmup failed (checkout falls back to inline price_data):", err.message ?? err);
  }
}

/**
 * Returns the cached Stripe price ID for a packId.
 * Throws if not resolved (e.g. warmup hasn't run or failed for this item).
 */
export function getPriceId(packId: string): string {
  const id = cachedPriceIds?.[packId];
  if (!id) throw new Error(`No Stripe price ID cached for packId: ${packId}`);
  return id;
}

/**
 * Returns the cached Stripe price ID or null if not available.
 * Use in checkout routes: fall back to inline price_data on null.
 */
export function tryGetPriceId(packId: string): string | null {
  return cachedPriceIds?.[packId] ?? null;
}
