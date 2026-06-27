/**
 * purchaseItems.ts
 *
 * Single source of truth for:
 *   • EXTRAS_ITEMS — all extras/membership purchasable items
 *   • ELEVATE_PACKS — all elevate packs
 *   • grantExtras / grantElevate — the ONLY functions that write entitlements to the DB
 *
 * These functions are called from TWO places:
 *   1. webhookHandlers.ts — checkout.session.completed (PRIMARY, authoritative)
 *   2. routes.ts activate endpoints — fallback only, logged as WEBHOOK_FALLBACK_GRANT
 *
 * NEITHER function touches processed_stripe_sessions — callers handle idempotency
 * before invoking these, so grant functions are safe to call without side effects.
 */

import { db } from './db';
import { sql, eq } from 'drizzle-orm';
import {
  userBenefits,
  callCredits,
  membershipSubscriptions,
  sparkBalances,
  sparkPurchases,
  userElevates,
} from '@shared/schema';

// ── Item / pack catalogues ────────────────────────────────────────────────────

export const EXTRAS_ITEMS = {
  "messages-5":           { name: "+5 Messages",           unitAmount: 499,  mode: "payment"      as const, benefitType: "message_extension" as const, credits: null,                  quantity: 1 },
  "undo-close":           { name: "Undo Last Pass",         unitAmount: 299,  mode: "payment"      as const, benefitType: "undo_close"         as const, credits: null,                  quantity: 1 },
  "membership":           { name: "Lulou Membership",       unitAmount: 1999, mode: "subscription" as const, benefitType: null,                          credits: null,                  quantity: 1 },
  "starter-pack":         { name: "Starter Pack",           unitAmount: 499,  mode: "payment"      as const, benefitType: null,                          credits: { phone: 1, video: 0 }, quantity: 1 },
  "video-starter":        { name: "Video Call Starter",     unitAmount: 699,  mode: "payment"      as const, benefitType: null,                          credits: { phone: 0, video: 1 }, quantity: 1 },
  "connection-pack":      { name: "Connection Pack",        unitAmount: 1299, mode: "payment"      as const, benefitType: null,                          credits: { phone: 3, video: 0 }, quantity: 1 },
  "premium-pack":         { name: "Premium Pack",           unitAmount: 1999, mode: "payment"      as const, benefitType: null,                          credits: { phone: 5, video: 0 }, quantity: 1 },
  "chemistry-pack":       { name: "Chemistry Pack",         unitAmount: 1699, mode: "payment"      as const, benefitType: null,                          credits: { phone: 3, video: 1 }, quantity: 1 },
  "deep-connection-pack": { name: "Deep Connection Pack",   unitAmount: 2799, mode: "payment"      as const, benefitType: null,                          credits: { phone: 5, video: 3 }, quantity: 1 },
  "voice-notes-unlock":   { name: "Voice Notes Unlock",     unitAmount: 499,  mode: "payment"      as const, benefitType: "voice_notes_unlock" as const, credits: null,                   quantity: 1 },
  "extra-call":           { name: "Extra Call",              unitAmount: 499,  mode: "payment"      as const, benefitType: null,                          credits: { phone: 1, video: 0 }, quantity: 1 },
  "sparks-1":             { name: "1 Halo",                  unitAmount: 299,  mode: "payment"      as const, benefitType: null, credits: null, quantity: 1 },
  "sparks-3":             { name: "3 Halos",                 unitAmount: 699,  mode: "payment"      as const, benefitType: null, credits: null, quantity: 3 },
  "sparks-5":             { name: "5 Halos",                 unitAmount: 999,  mode: "payment"      as const, benefitType: null, credits: null, quantity: 5 },
} as const;

export type ExtrasItemId = keyof typeof EXTRAS_ITEMS;

export const ELEVATE_PACKS = {
  "elevate-1":     { type: "elevate"       as const, quantity: 1, unitAmount: 999,  label: "1 Elevate (30 min)" },
  "elevate-3":     { type: "elevate"       as const, quantity: 3, unitAmount: 2699, label: "3 Elevates (30 min each)" },
  "elevate-5":     { type: "elevate"       as const, quantity: 5, unitAmount: 3999, label: "5 Elevates (30 min each)" },
  "super-elevate": { type: "super_elevate" as const, quantity: 1, unitAmount: 3499, label: "Super Elevate (60 min)" },
} as const;

export type ElevatePackId = keyof typeof ELEVATE_PACKS;

// ── Helpers ───────────────────────────────────────────────────────────────────

export function isUniqueViolation(err: any): boolean {
  return (
    err?.code === "23505" ||
    (err?.cause as any)?.code === "23505" ||
    String(err?.message ?? "").toLowerCase().includes("unique") ||
    String(err?.message ?? "").toLowerCase().includes("duplicate")
  );
}

// ── Grant functions ───────────────────────────────────────────────────────────
// Callers MUST claim processed_stripe_sessions BEFORE calling these.
// These functions are pure DB writes — they do not check idempotency themselves.

/**
 * Grant an extras entitlement. Returns the list of benefit types granted.
 * `session` must contain `.customer` and `.subscription` for membership items.
 */
export async function grantExtras(
  userId: string,
  sessionId: string,
  itemId: ExtrasItemId,
  session: { customer?: unknown; subscription?: unknown },
): Promise<string[]> {
  const item = EXTRAS_ITEMS[itemId];
  const grantedTypes: string[] = [];

  if (itemId === "membership") {
    const membershipRows = [
      { userId, type: "message_extension" as const },
      { userId, type: "message_extension" as const },
      { userId, type: "undo_close"         as const },
    ];
    await db.insert(userBenefits).values(membershipRows);

    await db
      .insert(callCredits)
      .values({ userId, phoneCredits: 3, videoCredits: 1 })
      .onConflictDoUpdate({
        target: callCredits.userId,
        set: {
          phoneCredits: sql`${callCredits.phoneCredits} + 3`,
          videoCredits: sql`${callCredits.videoCredits} + 1`,
          updatedAt: sql`now()`,
        },
      });

    const stripeCustomerId =
      typeof session.customer === "string"
        ? session.customer
        : (session.customer as any)?.id ?? null;
    const stripeSubscriptionId =
      typeof session.subscription === "string"
        ? session.subscription
        : (session.subscription as any)?.id ?? null;

    if (stripeCustomerId && stripeSubscriptionId) {
      await db
        .insert(membershipSubscriptions)
        .values({ userId, stripeCustomerId, stripeSubscriptionId, status: "active" })
        .onConflictDoUpdate({
          target: membershipSubscriptions.userId,
          set: { stripeCustomerId, stripeSubscriptionId, status: "active", updatedAt: new Date() },
        });
      console.log(`[PURCHASE] MEMBERSHIP_SUBSCRIPTION_RECORDED user=${userId} customer=${stripeCustomerId} sub=${stripeSubscriptionId}`);
    } else {
      console.warn(`[PURCHASE] MEMBERSHIP_NO_SUBSCRIPTION session=${sessionId} user=${userId} — renewal webhooks won't fire`);
    }

    grantedTypes.push(...membershipRows.map(r => r.type), "phone_credits:3", "video_credits:1");

  } else if ((itemId as string).startsWith("sparks-")) {
    const qty = item.quantity;
    await db.transaction(async (tx) => {
      await tx
        .insert(sparkBalances)
        .values({ userId, balance: qty })
        .onConflictDoUpdate({
          target: sparkBalances.userId,
          set: { balance: sql`spark_balances.balance + ${qty}`, updatedAt: new Date() },
        });
      await tx
        .insert(sparkPurchases)
        .values({ userId, packType: itemId, quantity: qty, stripeSessionId: sessionId })
        .onConflictDoNothing();
    });
    grantedTypes.push(...Array.from({ length: qty }, () => "spin_credit"));

  } else if (item.credits) {
    const { phone, video } = item.credits;
    if (phone > 0 || video > 0) {
      await db
        .insert(callCredits)
        .values({ userId, phoneCredits: phone, videoCredits: video })
        .onConflictDoUpdate({
          target: callCredits.userId,
          set: {
            phoneCredits: sql`${callCredits.phoneCredits} + ${phone}`,
            videoCredits: sql`${callCredits.videoCredits} + ${video}`,
            updatedAt: sql`now()`,
          },
        });
    }
    if (phone > 0) grantedTypes.push(`phone_credits:${phone}`);
    if (video > 0) grantedTypes.push(`video_credits:${video}`);

  } else if (item.benefitType) {
    const rows = Array.from({ length: item.quantity }, () => ({ userId, type: item.benefitType! }));
    await db.insert(userBenefits).values(rows);
    grantedTypes.push(...rows.map(r => r.type));
  }

  return grantedTypes;
}

export interface ElevateGrantResult {
  grantedTypes: string[];
  autoActivated: boolean;
  expiresAt: string | null;
  durationMinutes: number;
}

/**
 * Grant an elevate pack and auto-activate one boost immediately.
 * Returns activation metadata so success pages can display live status.
 */
export async function grantElevate(
  userId: string,
  packId: ElevatePackId,
): Promise<ElevateGrantResult> {
  const pack = ELEVATE_PACKS[packId];
  const isSuper = pack.type === "super_elevate";

  // Add all credits from the pack
  await db
    .insert(userElevates)
    .values({
      userId,
      elevateType: "elevate",
      expiresAt: new Date(0),
      elevateCredits: isSuper ? 0 : pack.quantity,
      superElevateCredits: isSuper ? pack.quantity : 0,
    })
    .onConflictDoUpdate({
      target: userElevates.userId,
      set: isSuper
        ? { superElevateCredits: sql`user_elevates.super_elevate_credits + ${pack.quantity}` }
        : { elevateCredits: sql`user_elevates.elevate_credits + ${pack.quantity}` },
    });

  // Auto-activate one boost immediately
  const durationMinutes = isSuper ? 60 : 30;
  const durationMs = durationMinutes * 60 * 1000;
  const expiresAt = new Date(Date.now() + durationMs);
  const activatedAt = new Date();

  try {
    await db
      .update(userElevates)
      .set(
        isSuper
          ? { elevateType: pack.type, expiresAt, activatedAt, superElevateCredits: sql`GREATEST(super_elevate_credits - 1, 0)` }
          : { elevateType: pack.type, expiresAt, activatedAt, elevateCredits:      sql`GREATEST(elevate_credits - 1, 0)` },
      )
      .where(eq(userElevates.userId, userId));
  } catch (err) {
    console.error("[PURCHASE] grantElevate: auto-activate failed:", err);
    return {
      grantedTypes: Array.from({ length: pack.quantity }, () => `${pack.type}_credit`),
      autoActivated: false,
      expiresAt: null,
      durationMinutes,
    };
  }

  return {
    grantedTypes: Array.from({ length: pack.quantity }, () => `${pack.type}_credit`),
    autoActivated: true,
    expiresAt: expiresAt.toISOString(),
    durationMinutes,
  };
}
