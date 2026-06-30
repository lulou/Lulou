import { getUncachableStripeClient, getWebhookSecret } from './stripeClient';
import { db } from './db';
import { sql } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import { processedStripeSessions, userBenefits, callCredits, membershipSubscriptions } from '@shared/schema';
import { EXTRAS_ITEMS, ELEVATE_PACKS, type ExtrasItemId, type ElevatePackId, grantExtras, grantElevate, isUniqueViolation } from './purchaseItems';
import { supabaseAdmin } from './supabase';
import { sendEmail } from './emailService';
import {
  purchaseConfirmationEmail,
  haloPurchaseEmail,
  elevatePurchaseEmail,
  subscriptionConfirmationEmail,
  subscriptionCancellationEmail,
  refundConfirmationEmail,
} from './emailTemplates';

// ── Membership bundle granted on every successful subscription renewal ────────
const MEMBERSHIP_BUNDLE = {
  messageExtensions: 2,
  undoClose: 1,
  phoneCredits: 3,
  videoCredits: 1,
} as const;

// ── User info lookup ──────────────────────────────────────────────────────────
// Fetches email + firstName for a Lulou userId. Never throws — returns nulls
// on failure so email sending never blocks the grant path.

interface UserInfo {
  email:     string | null;
  firstName: string | null;
}

async function getUserInfo(userId: string): Promise<UserInfo> {
  try {
    const [authResult, profileResult] = await Promise.all([
      supabaseAdmin.auth.admin.getUserById(userId),
      supabaseAdmin
        .from("profiles")
        .select("firstName")
        .eq("userId", userId)
        .single(),
    ]);

    return {
      email:     authResult.data?.user?.email ?? null,
      firstName: (profileResult.data as any)?.firstName ?? null,
    };
  } catch (err: any) {
    console.warn(`[EMAIL] getUserInfo failed for ${userId.slice(0,8)}: ${err?.message}`);
    return { email: null, firstName: null };
  }
}

// ── Currency formatter ────────────────────────────────────────────────────────

function formatAmount(amountCents: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-AU", {
      style:    "currency",
      currency: currency.toUpperCase(),
      minimumFractionDigits: 2,
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

// ── Date formatter ────────────────────────────────────────────────────────────

function formatDate(ts: number): string {
  return new Date(ts * 1000).toLocaleDateString("en-AU", {
    day: "numeric", month: "long", year: "numeric",
  });
}

// ── Product name lookup ───────────────────────────────────────────────────────

function getProductName(itemId?: string, packId?: string): string {
  if (itemId && EXTRAS_ITEMS[itemId as ExtrasItemId]) {
    return EXTRAS_ITEMS[itemId as ExtrasItemId].name;
  }
  if (packId && ELEVATE_PACKS[packId as ElevatePackId]) {
    return ELEVATE_PACKS[packId as ElevatePackId].label;
  }
  return "Lulou Purchase";
}

// ── grantMembershipBundle ─────────────────────────────────────────────────────

async function grantMembershipBundle(userId: string, invoiceId: string): Promise<boolean> {
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

  const benefitRows = [
    ...Array.from({ length: MEMBERSHIP_BUNDLE.messageExtensions }, () => ({ userId, type: "message_extension" })),
    ...Array.from({ length: MEMBERSHIP_BUNDLE.undoClose },         () => ({ userId, type: "undo_close" })),
  ];
  await db.insert(userBenefits).values(benefitRows);

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
    const periodEnd: number | undefined = invoice.lines?.data?.[0]?.period?.end;
    if (periodEnd) {
      await db
        .update(membershipSubscriptions)
        .set({ currentPeriodEnd: new Date(periodEnd * 1000), updatedAt: new Date() })
        .where(eq(membershipSubscriptions.userId, sub.userId));
    }

    // Send subscription renewal email (fire-and-forget)
    void (async () => {
      try {
        const info   = await getUserInfo(sub.userId);
        const amount = formatAmount(invoice.amount_paid ?? 1999, invoice.currency ?? "aud");
        const next   = periodEnd ? formatDate(periodEnd) : "next month";
        if (info.email) {
          await sendEmail({
            to:      info.email,
            subject: "Your Lulou Membership has renewed ❤️",
            html:    subscriptionConfirmationEmail(info.firstName ?? "there", amount, next, invoice.id),
            type:    "membership_renewal",
          });
        }
      } catch (emailErr: any) {
        console.warn(`[EMAIL] membership_renewal email failed: ${emailErr?.message}`);
      }
    })();
  }
}

// ── customer.subscription.deleted ────────────────────────────────────────────

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

    // Send cancellation email (fire-and-forget)
    void (async () => {
      try {
        const userId  = updated[0].userId;
        const info    = await getUserInfo(userId);
        const endDate = subscription.current_period_end
          ? formatDate(subscription.current_period_end)
          : "end of billing period";
        if (info.email) {
          await sendEmail({
            to:      info.email,
            subject: "Your Lulou Membership has been cancelled",
            html:    subscriptionCancellationEmail(info.firstName ?? "there", endDate),
            type:    "subscription_cancelled",
          });
        }
      } catch (emailErr: any) {
        console.warn(`[EMAIL] subscription_cancelled email failed: ${emailErr?.message}`);
      }
    })();
  } else {
    console.log(`[WEBHOOK] customer.subscription.deleted: no matching subscription for customer ${customerId}`);
  }
}

// ── checkout.session.completed ────────────────────────────────────────────────

async function handleCheckoutSessionCompleted(session: any): Promise<void> {
  const userId: string | undefined = session.metadata?.userId;
  const itemId: string | undefined = session.metadata?.itemId;
  const packId: string | undefined = session.metadata?.packId;

  if (!userId) {
    console.warn(`[WEBHOOK] checkout.session.completed: no userId in metadata session=${session.id} — skipping`);
    return;
  }

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

  // ── Idempotency guard ──────────────────────────────────────────────────────
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

  // ── Grant the entitlement ──────────────────────────────────────────────────
  let grantedProductName = getProductName(itemId, packId);
  let isElevate          = false;
  let isSuperElevate     = false;
  let sparksQty          = 0;

  try {
    if (itemId && EXTRAS_ITEMS[itemId as ExtrasItemId]) {
      const grantedTypes = await grantExtras(userId, session.id, itemId as ExtrasItemId, session);
      console.log(`[PURCHASE] ENTITLEMENT_GRANTED source=webhook user=${userId} product=${itemId} granted=${grantedTypes.join(", ")}`);
      if ((itemId as string).startsWith("sparks-")) {
        sparksQty = EXTRAS_ITEMS[itemId as ExtrasItemId].quantity;
      }

    } else if (packId && ELEVATE_PACKS[packId as ElevatePackId]) {
      const result = await grantElevate(userId, packId as ElevatePackId);
      console.log(`[PURCHASE] ENTITLEMENT_GRANTED source=webhook user=${userId} product=${packId} granted=${result.grantedTypes.join(", ")} autoActivated=${result.autoActivated}`);
      isSuperElevate = ELEVATE_PACKS[packId as ElevatePackId].type === "super_elevate";
      isElevate      = !isSuperElevate;

    } else {
      console.log(`[WEBHOOK] checkout.session.completed: no recognised itemId/packId in metadata session=${session.id} itemId=${itemId} packId=${packId} — no app grant needed`);
    }
  } catch (grantErr: any) {
    try {
      await db.delete(processedStripeSessions)
        .where(eq(processedStripeSessions.sessionId, session.id));
    } catch {}
    console.error(`[WEBHOOK] checkout.session.completed: grant failed for session=${session.id} user=${userId}`, grantErr?.message);
    throw grantErr;
  }

  // ── Send purchase confirmation email (fire-and-forget) ────────────────────
  void (async () => {
    try {
      const [info, stripe] = await Promise.all([
        getUserInfo(userId),
        Promise.resolve(getUncachableStripeClient()),
      ]);

      if (!info.email) return;

      const amountCents: number = session.amount_total ?? 0;
      const currency: string    = session.currency ?? "aud";
      const amount              = formatAmount(amountCents, currency);
      const firstName           = info.firstName ?? "there";

      let subject: string;
      let html: string;

      if (session.mode === "subscription") {
        // Subscription confirmation
        const subId = typeof session.subscription === "string"
          ? session.subscription : (session.subscription as any)?.id;
        let nextBillingDate = "next month";
        if (subId) {
          try {
            const sub = await stripe.subscriptions.retrieve(subId as string) as any;
            nextBillingDate = formatDate(sub.current_period_end);
          } catch {}
        }
        subject = "Welcome to Lulou Membership ❤️";
        html    = subscriptionConfirmationEmail(firstName, amount, nextBillingDate, session.id);

      } else if (sparksQty > 0) {
        // Halo / Sparks pack
        subject = sparksQty === 1
          ? "Your Halo is ready to send ✨"
          : `Your ${sparksQty} Halos are ready to send ✨`;
        html    = haloPurchaseEmail(firstName, sparksQty, amount, session.id);

      } else if (isElevate || isSuperElevate) {
        // Elevate pack
        const packLabel = packId ? (ELEVATE_PACKS[packId as ElevatePackId]?.label ?? grantedProductName) : grantedProductName;
        subject = isSuperElevate ? "Your Super Elevate is ready 🚀" : "Your Elevate boost is ready ✨";
        html    = elevatePurchaseEmail(firstName, packLabel, amount, session.id, isSuperElevate);

      } else {
        // Generic purchase confirmation
        subject = `Your ${grantedProductName} purchase is confirmed ❤️`;
        html    = purchaseConfirmationEmail(firstName, grantedProductName, amount, session.id);
      }

      await sendEmail({ to: info.email, subject, html, type: `purchase_${itemId ?? packId ?? "generic"}` });

    } catch (emailErr: any) {
      console.warn(`[EMAIL] purchase confirmation email failed for session=${session.id}: ${emailErr?.message}`);
    }
  })();
}

// ── charge.refunded ───────────────────────────────────────────────────────────
// Fired when a refund is issued on a charge (partial or full).
// Looks up the originating checkout session to find the userId, then sends
// a branded refund confirmation email.

async function handleChargeRefunded(charge: any): Promise<void> {
  const paymentIntentId: string | undefined =
    typeof charge.payment_intent === "string"
      ? charge.payment_intent
      : (charge.payment_intent?.id ?? undefined);

  const refundObj  = charge.refunds?.data?.[0];
  const refundId   = refundObj?.id ?? charge.id ?? "N/A";
  const refundCents: number = charge.amount_refunded ?? 0;
  const currency: string    = charge.currency ?? "aud";

  console.log(`[WEBHOOK] charge.refunded: paymentIntent=${paymentIntentId ?? "none"} refundId=${refundId} amount=${refundCents} ${currency}`);

  if (!paymentIntentId) {
    console.warn("[WEBHOOK] charge.refunded: no payment_intent on charge — cannot look up user");
    return;
  }

  // ── Find checkout session & userId ────────────────────────────────────────
  let userId:      string | undefined;
  let itemId:      string | undefined;
  let packId:      string | undefined;

  try {
    const stripe  = getUncachableStripeClient();
    const sessions = await stripe.checkout.sessions.list({
      payment_intent: paymentIntentId,
      limit: 1,
    });
    const session = sessions.data[0];
    if (session) {
      userId = session.metadata?.userId;
      itemId = session.metadata?.itemId;
      packId = session.metadata?.packId;
    }
  } catch (lookupErr: any) {
    console.warn(`[WEBHOOK] charge.refunded: session lookup failed for pi=${paymentIntentId}: ${lookupErr?.message}`);
  }

  const productName = getProductName(itemId, packId);
  const amount      = formatAmount(refundCents, currency);

  console.log(`[WEBHOOK] REFUND_CONFIRMED refundId=${refundId} user=${userId ?? "unknown"} product=${productName} amount=${amount}`);

  if (!userId) {
    console.warn("[WEBHOOK] charge.refunded: could not determine userId — email not sent");
    return;
  }

  // Send refund email (fire-and-forget, never blocks webhook response)
  void (async () => {
    try {
      const info = await getUserInfo(userId!);
      if (!info.email) return;
      await sendEmail({
        to:      info.email,
        subject: "Your Lulou refund has been processed ❤️",
        html:    refundConfirmationEmail(info.firstName ?? "there", amount, productName, refundId),
        type:    "refund_confirmation",
      });
    } catch (emailErr: any) {
      console.warn(`[EMAIL] refund_confirmation email failed for refundId=${refundId}: ${emailErr?.message}`);
    }
  })();
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

    const stripe = getUncachableStripeClient();
    const secret = await getWebhookSecret();
    const event  = stripe.webhooks.constructEvent(payload, signature, secret);

    try {
      if (event.type === "checkout.session.completed") {
        await handleCheckoutSessionCompleted(event.data.object);
      } else if (event.type === "invoice.payment_succeeded") {
        await handleInvoicePaymentSucceeded(event.data.object);
      } else if (event.type === "customer.subscription.deleted") {
        await handleSubscriptionDeleted(event.data.object);
      } else if (event.type === "charge.refunded") {
        await handleChargeRefunded(event.data.object);
      }
    } catch (err: any) {
      console.error(`[WEBHOOK] Application handler error for ${event.type}:`, err?.message);
    }
  }
}
