import { getStripeSync } from './stripeClient';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { processedStripeSessions, userBenefits, callCredits, membershipSubscriptions } from '@shared/schema';
import { EXTRAS_ITEMS, ELEVATE_PACKS, type ExtrasItemId, type ElevatePackId, grantExtras, grantElevate, isUniqueViolation } from './purchaseItems';

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

  console.log(`[WEBHOOK] PAYMENT_CONFIRMED product=membership_renewal user=${sub.userId} invoice=${invoice.id} customer=${customerId}`);

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

// ── checkout.session.completed ────────────────────────────────────────────────
// PRIMARY entitlement grant path for all one-time purchases and initial
// subscription activations. This is the ONLY trusted grant path — it fires
// after Stripe cryptographically confirms the payment.
// The activate endpoints in routes.ts are fallbacks only, logged separately.
async function handleCheckoutSessionCompleted(session: any): Promise<void> {
  const userId: string | undefined = session.metadata?.userId;
  const itemId: string | undefined = session.metadata?.itemId;
  const packId: string | undefined = session.metadata?.packId;

  if (!userId) {
    console.warn(`[WEBHOOK] checkout.session.completed: no userId in metadata session=${session.id} — skipping`);
    return;
  }

  // Verify Stripe actually confirmed payment
  const isPaid =
    session.mode === "subscription"
      ? session.status === "complete"
      : session.payment_status === "paid";

  if (!isPaid) {
    console.log(
      `[WEBHOOK] checkout.session.completed: payment not confirmed` +
      ` session=${session.id} status=${session.status} payment_status=${session.payment_status} — skipping`,
    );
    return;
  }

  console.log(`[WEBHOOK] PAYMENT_CONFIRMED session=${session.id} user=${userId} product=${itemId ?? packId ?? "unknown"} mode=${session.mode}`);

  // ── Idempotency guard ─────────────────────────────────────────────────────
  // Claim session ID before any grant. If the activate fallback already ran,
  // this insert fails → we log and skip. Duplicate webhook deliveries are safe.
  try {
    await db.insert(processedStripeSessions).values({
      sessionId: session.id,
      userId,
      itemRef: itemId ?? packId ?? "",
    });
  } catch (insertErr: any) {
    if (isUniqueViolation(insertErr)) {
      console.log(`[WEBHOOK] checkout.session.completed: session ${session.id} already processed — idempotent skip`);
      return;
    }
    throw insertErr;
  }

  // ── Grant the entitlement ─────────────────────────────────────────────────
  try {
    if (itemId && EXTRAS_ITEMS[itemId as ExtrasItemId]) {
      const grantedTypes = await grantExtras(userId, session.id, itemId as ExtrasItemId, session);
      console.log(`[PURCHASE] ENTITLEMENT_GRANTED source=webhook user=${userId} product=${itemId} granted=${grantedTypes.join(", ")}`);

    } else if (packId && ELEVATE_PACKS[packId as ElevatePackId]) {
      const result = await grantElevate(userId, packId as ElevatePackId);
      console.log(`[PURCHASE] ENTITLEMENT_GRANTED source=webhook user=${userId} product=${packId} granted=${result.grantedTypes.join(", ")} autoActivated=${result.autoActivated}`);

    } else {
      // Session created by stripe-replit-sync or another flow — not an app purchase
      console.log(`[WEBHOOK] checkout.session.completed: no recognised itemId/packId in metadata session=${session.id} itemId=${itemId} packId=${packId} — no app grant needed`);
    }
  } catch (grantErr: any) {
    // Remove the processed_stripe_sessions claim so the activate fallback
    // (or a webhook retry) can still grant — the user paid and must receive benefits.
    try {
      await db.delete(processedStripeSessions)
        .where(eq(processedStripeSessions.sessionId, session.id));
    } catch {}
    console.error(`[WEBHOOK] checkout.session.completed: grant failed for session=${session.id} user=${userId}`, grantErr?.message);
    throw grantErr; // rethrow so the outer handler logs it but does NOT rethrow to Stripe
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
      if (event.type === "checkout.session.completed") {
        await handleCheckoutSessionCompleted(event.data.object);
      } else if (event.type === "invoice.payment_succeeded") {
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
