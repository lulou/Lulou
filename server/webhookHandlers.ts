import { getStripeSync } from './stripeClient';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { processedStripeSessions, userBenefits, callCredits, membershipSubscriptions } from '@shared/schema';

// ── Membership bundle granted on every successful subscription renewal ────────
// This must stay in sync with the initial grant in extras-activate (routes.ts).
const MEMBERSHIP_BUNDLE = {
  messageExtensions: 2,
  undoClose: 1,
  phoneCredits: 3,
  videoCredits: 1,
} as const;

/**
 * Grants the membership bundle to a user for a given invoice, idempotently.
 * Uses the invoice ID as the key in processed_stripe_sessions so duplicate
 * webhook deliveries never double-grant.
 * Returns true if granted, false if already processed.
 */
async function grantMembershipBundle(userId: string, invoiceId: string): Promise<boolean> {
  // Claim the invoice ID — unique PK prevents double-grant
  try {
    await db.insert(processedStripeSessions).values({
      sessionId: invoiceId,
      userId,
      itemRef: "membership_renewal",
    });
  } catch (err: any) {
    const isUnique =
      err.code === "23505" ||
      (err.cause as any)?.code === "23505" ||
      String(err?.message ?? "").toLowerCase().includes("unique") ||
      String(err?.message ?? "").toLowerCase().includes("duplicate");
    if (isUnique) {
      console.log(`[WEBHOOK] membership_renewal: invoice ${invoiceId} already processed for ${userId} — skipping`);
      return false;
    }
    throw err;
  }

  // Grant benefit rows
  const benefitRows = [
    ...Array.from({ length: MEMBERSHIP_BUNDLE.messageExtensions }, () => ({ userId, type: "message_extension" })),
    ...Array.from({ length: MEMBERSHIP_BUNDLE.undoClose },         () => ({ userId, type: "undo_close" })),
  ];
  await db.insert(userBenefits).values(benefitRows);

  // Add call credits via upsert (accumulate on top of existing balance)
  await db
    .insert(callCredits)
    .values({ userId, phoneCredits: MEMBERSHIP_BUNDLE.phoneCredits, videoCredits: MEMBERSHIP_BUNDLE.videoCredits })
    .onConflictDoUpdate({
      target: callCredits.userId,
      set: {
        phoneCredits: sql`${callCredits.phoneCredits} + ${MEMBERSHIP_BUNDLE.phoneCredits}`,
        videoCredits: sql`${callCredits.videoCredits} + ${MEMBERSHIP_BUNDLE.videoCredits}`,
        updatedAt: sql`now()`,
      },
    });

  console.log(
    `[WEBHOOK] Membership bundle granted → user=${userId} invoice=${invoiceId}: ` +
    `${MEMBERSHIP_BUNDLE.messageExtensions}×message_extension, ` +
    `${MEMBERSHIP_BUNDLE.undoClose}×undo_close, ` +
    `${MEMBERSHIP_BUNDLE.phoneCredits} phone credits, ` +
    `${MEMBERSHIP_BUNDLE.videoCredits} video credit`,
  );
  return true;
}

// ── invoice.payment_succeeded ─────────────────────────────────────────────────
// Only handles subscription_cycle (monthly renewal).
// The initial subscription_create payment is handled by the extras-activate
// redirect flow so we skip it here to avoid double-granting.
async function handleInvoicePaymentSucceeded(invoice: any): Promise<void> {
  if (invoice.billing_reason !== "subscription_cycle") {
    console.log(`[WEBHOOK] invoice.payment_succeeded: billing_reason="${invoice.billing_reason}" — skipping (not a renewal)`);
    return;
  }

  const customerId = typeof invoice.customer === "string"
    ? invoice.customer
    : (invoice.customer?.id ?? null);

  if (!customerId) {
    console.warn("[WEBHOOK] invoice.payment_succeeded: missing customer ID");
    return;
  }

  const [sub] = await db
    .select({ userId: membershipSubscriptions.userId })
    .from(membershipSubscriptions)
    .where(eq(membershipSubscriptions.stripeCustomerId, customerId))
    .limit(1);

  if (!sub) {
    console.log(`[WEBHOOK] invoice.payment_succeeded: no membership subscription for customer ${customerId} — skipping`);
    return;
  }

  const granted = await grantMembershipBundle(sub.userId, invoice.id);

  if (granted) {
    // Update currentPeriodEnd from the invoice line item
    const periodEnd: number | undefined = invoice.lines?.data?.[0]?.period?.end;
    if (periodEnd) {
      await db
        .update(membershipSubscriptions)
        .set({ currentPeriodEnd: new Date(periodEnd * 1000), updatedAt: new Date() })
        .where(eq(membershipSubscriptions.userId, sub.userId));
    }
  }
}

// ── customer.subscription.deleted ────────────────────────────────────────────
// Marks the membership as cancelled so the status endpoint returns false.
// Credits and benefits already granted are NOT removed — they were paid for.
async function handleSubscriptionDeleted(subscription: any): Promise<void> {
  const customerId = typeof subscription.customer === "string"
    ? subscription.customer
    : (subscription.customer?.id ?? null);

  if (!customerId) {
    console.warn("[WEBHOOK] customer.subscription.deleted: missing customer ID");
    return;
  }

  const updated = await db
    .update(membershipSubscriptions)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(membershipSubscriptions.stripeCustomerId, customerId))
    .returning({ userId: membershipSubscriptions.userId });

  if (updated.length > 0) {
    console.log(`[WEBHOOK] Membership cancelled → user=${updated[0].userId} customer=${customerId}`);
  } else {
    console.log(`[WEBHOOK] customer.subscription.deleted: no matching subscription for customer ${customerId}`);
  }
}

// ── Main entry point ──────────────────────────────────────────────────────────
export class WebhookHandlers {
  static async processWebhook(payload: Buffer, signature: string): Promise<void> {
    if (!Buffer.isBuffer(payload)) {
      throw new Error(
        'STRIPE WEBHOOK ERROR: Payload must be a Buffer. ' +
        'This usually means express.json() parsed the body before reaching this handler. ' +
        'FIX: Ensure webhook route is registered BEFORE app.use(express.json()).',
      );
    }

    // stripe-replit-sync verifies the Stripe signature and throws on failure.
    // After this line succeeds the payload is cryptographically trusted.
    const sync = await getStripeSync();
    await sync.processWebhook(payload, signature);

    // ── Application-layer handlers ────────────────────────────────────────────
    // Parse the verified payload to run our own benefit-granting logic.
    let event: { type: string; data: { object: any } };
    try {
      event = JSON.parse(payload.toString());
    } catch {
      return;
    }

    try {
      if (event.type === "invoice.payment_succeeded") {
        await handleInvoicePaymentSucceeded(event.data.object);
      } else if (event.type === "customer.subscription.deleted") {
        await handleSubscriptionDeleted(event.data.object);
      }
    } catch (err: any) {
      // Log but never rethrow — the sync already succeeded.
      // Rethrowing would cause Stripe to retry the webhook unnecessarily.
      console.error(`[WEBHOOK] Application handler error for ${event.type}:`, err?.message);
    }
  }
}
