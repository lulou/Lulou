/**
 * Stripe products and prices for Elevate boosts.
 * On first call, this module looks up existing products/prices by lookup_key
 * and creates them if they don't exist. Price IDs are cached in memory for
 * the lifetime of the server process.
 */

import { getUncachableStripeClient } from "./stripeClient";

type PackPriceIds = Record<string, string>; // packId → priceId

let cachedPriceIds: PackPriceIds | null = null;

const PACK_DEFINITIONS = [
  {
    packId: "elevate-1",
    productName: "Lulou Elevate",
    lookupKey: "lulou_elevate_1",
    unitAmount: 999,
    currency: "usd",
    description: "3× visibility boost in Discovery for 30 minutes",
  },
  {
    packId: "elevate-3",
    productName: "Lulou Elevate Pack (3)",
    lookupKey: "lulou_elevate_3",
    unitAmount: 2699,
    currency: "usd",
    description: "3× visibility boost · 3 boosts · 30 minutes each",
  },
  {
    packId: "elevate-5",
    productName: "Lulou Elevate Pack (5)",
    lookupKey: "lulou_elevate_5",
    unitAmount: 3999,
    currency: "usd",
    description: "3× visibility boost · 5 boosts · 30 minutes each",
  },
  {
    packId: "super-elevate",
    productName: "Lulou Super Elevate",
    lookupKey: "lulou_super_elevate",
    unitAmount: 3499,
    currency: "usd",
    description: "8× visibility boost — top of Discovery and Intention Wheel for 60 minutes",
  },
] as const;

async function ensurePriceIds(): Promise<PackPriceIds> {
  if (cachedPriceIds) return cachedPriceIds;

  const stripe = await getUncachableStripeClient();
  const result: PackPriceIds = {};

  for (const def of PACK_DEFINITIONS) {
    try {
      // Try to find existing price by lookup_key
      const existing = await stripe.prices.list({
        lookup_keys: [def.lookupKey],
        active: true,
        limit: 1,
      });

      if (existing.data.length > 0) {
        result[def.packId] = existing.data[0].id;
        console.log(`[STRIPE] Reusing price ${existing.data[0].id} for ${def.packId}`);
        continue;
      }

      // Create product then price
      const product = await stripe.products.create({
        name: def.productName,
        description: def.description,
      });

      const price = await stripe.prices.create({
        product: product.id,
        unit_amount: def.unitAmount,
        currency: def.currency,
        lookup_key: def.lookupKey,
        transfer_lookup_key: false,
      });

      result[def.packId] = price.id;
      console.log(`[STRIPE] Created price ${price.id} (${def.packId}) for product ${product.id}`);
    } catch (err: any) {
      console.error(`[STRIPE] Failed to ensure price for ${def.packId}:`, err.message ?? err);
      throw err;
    }
  }

  cachedPriceIds = result;
  return result;
}

export async function getPriceId(packId: string): Promise<string> {
  const ids = await ensurePriceIds();
  const id = ids[packId];
  if (!id) throw new Error(`No Stripe price found for packId: ${packId}`);
  return id;
}

/** Call at server startup to warm up the cache and catch config errors early. */
export async function warmupStripePrices(): Promise<void> {
  try {
    await ensurePriceIds();
    console.log("[STRIPE] Price IDs ready:", Object.keys(cachedPriceIds ?? {}).join(", "));
  } catch (err: any) {
    console.warn("[STRIPE] Price warmup failed (will retry on first checkout):", err.message ?? err);
  }
}
