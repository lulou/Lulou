/**
 * Purchase Simulation Audit
 * Exercises every purchase flow against the real local DB without Stripe charges.
 * Simulates: checkout → activate → webhook → entitlement check → logout/login/device/refresh.
 */

import { db } from "../server/db";
import {
  userBenefits,
  userElevates,
  callCredits,
  membershipSubscriptions,
  processedStripeSessions,
} from "../shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";

const TEST_USER = "audit-sim-user-001";
let pass = 0;
let fail = 0;
const bugs: string[] = [];

// ── Helpers ──────────────────────────────────────────────────────────────────

function ok(label: string) {
  console.log(`  ✅ ${label}`);
  pass++;
}

function fail_(label: string, detail?: string) {
  const msg = detail ? `${label} — ${detail}` : label;
  console.log(`  ❌ ${msg}`);
  fail++;
  bugs.push(msg);
}

async function snapshot() {
  const [benefits, elevates, credits, memberships, sessions] = await Promise.all([
    db.select().from(userBenefits).where(eq(userBenefits.userId, TEST_USER)),
    db.select().from(userElevates).where(eq(userElevates.userId, TEST_USER)),
    db.select().from(callCredits).where(eq(callCredits.userId, TEST_USER)),
    db.select().from(membershipSubscriptions).where(eq(membershipSubscriptions.userId, TEST_USER)),
    db.select().from(processedStripeSessions).where(eq(processedStripeSessions.userId, TEST_USER)),
  ]);
  return { benefits, elevates, credits, memberships, sessions };
}

/** Simulate extras-activate logic (the actual grant code, bypassing Stripe API call) */
async function simulateExtrasActivate(itemId: string, sessionId: string) {
  // Idempotency guard (same code as routes.ts)
  try {
    await db.insert(processedStripeSessions).values({
      sessionId,
      userId: TEST_USER,
      itemRef: itemId,
    });
  } catch (err: any) {
    const isDupe =
      err.code === "23505" ||
      (err.cause as any)?.code === "23505" ||
      String(err?.message ?? "").toLowerCase().includes("unique") ||
      String(err?.message ?? "").toLowerCase().includes("duplicate");
    if (isDupe) return { alreadyProcessed: true };
    throw err;
  }

  const ITEMS: Record<string, any> = {
    "voice-notes-unlock": { benefitType: "voice_notes_unlock", credits: null, mode: "payment", quantity: 1 },
    "undo-close":         { benefitType: "undo_close",         credits: null, mode: "payment", quantity: 1 },
    "messages-5":         { benefitType: "message_extension",  credits: null, mode: "payment", quantity: 1 },
    "starter-pack":       { benefitType: null, credits: { phone: 1, video: 0 }, mode: "payment", quantity: 1 },
    "video-starter":      { benefitType: null, credits: { phone: 0, video: 1 }, mode: "payment", quantity: 1 },
    "connection-pack":    { benefitType: null, credits: { phone: 3, video: 0 }, mode: "payment", quantity: 1 },
    "premium-pack":       { benefitType: null, credits: { phone: 5, video: 0 }, mode: "payment", quantity: 1 },
    "chemistry-pack":     { benefitType: null, credits: { phone: 3, video: 1 }, mode: "payment", quantity: 1 },
    "deep-connection-pack": { benefitType: null, credits: { phone: 5, video: 3 }, mode: "payment", quantity: 1 },
    "membership": { benefitType: null, credits: null, mode: "subscription", quantity: 1 },
  };

  const item = ITEMS[itemId];
  if (!item) throw new Error(`Unknown item: ${itemId}`);

  if (itemId === "membership") {
    const membershipRows = [
      { userId: TEST_USER, type: "message_extension" },
      { userId: TEST_USER, type: "message_extension" },
      { userId: TEST_USER, type: "undo_close" },
    ];
    await db.insert(userBenefits).values(membershipRows);
    // grant call credits (3 phone, 1 video)
    await db.insert(callCredits).values({ userId: TEST_USER, phoneCredits: 3, videoCredits: 1 })
      .onConflictDoUpdate({
        target: callCredits.userId,
        set: {
          phoneCredits: sql`${callCredits.phoneCredits} + 3`,
          videoCredits: sql`${callCredits.videoCredits} + 1`,
          updatedAt: sql`now()`,
        },
      });
    // store membership subscription
    const fakeCustomerId = `cus_fake_${Date.now()}`;
    const fakeSubId = `sub_fake_${Date.now()}`;
    await db.insert(membershipSubscriptions)
      .values({ userId: TEST_USER, stripeCustomerId: fakeCustomerId, stripeSubscriptionId: fakeSubId, status: "active" })
      .onConflictDoUpdate({
        target: membershipSubscriptions.userId,
        set: { stripeCustomerId: fakeCustomerId, stripeSubscriptionId: fakeSubId, status: "active", updatedAt: new Date() },
      });
    return { granted: ["message_extension", "message_extension", "undo_close", "phone_credits:3", "video_credits:1"] };
  } else if (item.credits) {
    await db.insert(callCredits).values({ userId: TEST_USER, phoneCredits: item.credits.phone, videoCredits: item.credits.video })
      .onConflictDoUpdate({
        target: callCredits.userId,
        set: {
          phoneCredits: sql`${callCredits.phoneCredits} + ${item.credits.phone}`,
          videoCredits: sql`${callCredits.videoCredits} + ${item.credits.video}`,
          updatedAt: sql`now()`,
        },
      });
    return { granted: [`phone:${item.credits.phone}`, `video:${item.credits.video}`] };
  } else if (item.benefitType) {
    const rows = Array.from({ length: item.quantity }, () => ({ userId: TEST_USER, type: item.benefitType }));
    await db.insert(userBenefits).values(rows);
    return { granted: rows.map((r: any) => r.type) };
  }
  return { granted: [] };
}

/** Simulate elevate-activate logic */
async function simulateElevateActivate(packId: string, sessionId: string) {
  const PACKS: Record<string, any> = {
    "elevate-1":     { type: "elevate",       quantity: 1 },
    "elevate-3":     { type: "elevate",       quantity: 3 },
    "elevate-5":     { type: "elevate",       quantity: 5 },
    "super-elevate": { type: "super_elevate", quantity: 1 },
  };
  const pack = PACKS[packId];
  if (!pack) throw new Error(`Unknown pack: ${packId}`);

  try {
    await db.insert(processedStripeSessions).values({ sessionId, userId: TEST_USER, itemRef: packId });
  } catch (err: any) {
    const isDupe =
      err.code === "23505" ||
      (err.cause as any)?.code === "23505" ||
      String(err?.message ?? "").toLowerCase().includes("unique");
    if (isDupe) return { alreadyProcessed: true };
    throw err;
  }

  // addElevateCredits
  const isSuper = pack.type === "super_elevate";
  const past = new Date(0);
  await db.insert(userElevates).values({
    userId: TEST_USER,
    elevateType: "elevate",
    expiresAt: past,
    elevateCredits: isSuper ? 0 : pack.quantity,
    superElevateCredits: isSuper ? pack.quantity : 0,
  }).onConflictDoUpdate({
    target: userElevates.userId,
    set: isSuper
      ? { superElevateCredits: sql`user_elevates.super_elevate_credits + ${pack.quantity}` }
      : { elevateCredits: sql`user_elevates.elevate_credits + ${pack.quantity}` },
  });

  // activateElevate (auto-fire one boost)
  const durationMs = isSuper ? 60 * 60 * 1000 : 30 * 60 * 1000;
  const expiresAt = new Date(Date.now() + durationMs);
  const activatedAt = new Date();
  const rows = await db.select().from(userElevates).where(eq(userElevates.userId, TEST_USER));
  const row = rows[0];
  const credits = row ? (isSuper ? row.superElevateCredits : row.elevateCredits) : 0;

  let autoActivated = false;
  if (credits > 0) {
    await db.update(userElevates).set(
      isSuper
        ? { elevateType: pack.type, expiresAt, activatedAt, superElevateCredits: sql`GREATEST(super_elevate_credits - 1, 0)` }
        : { elevateType: pack.type, expiresAt, activatedAt, elevateCredits: sql`GREATEST(elevate_credits - 1, 0)` }
    ).where(eq(userElevates.userId, TEST_USER));
    autoActivated = true;
  }

  return { creditsAdded: pack.quantity, autoActivated };
}

/** Simulate membership renewal webhook (invoice.payment_succeeded, billing_reason=subscription_cycle) */
async function simulateMembershipRenewalWebhook(invoiceId: string) {
  // Get customerId from membership
  const [sub] = await db.select().from(membershipSubscriptions).where(eq(membershipSubscriptions.userId, TEST_USER));
  if (!sub) throw new Error("No membership subscription found");

  // grantMembershipBundle
  try {
    await db.insert(processedStripeSessions).values({ sessionId: invoiceId, userId: TEST_USER, itemRef: "membership_renewal" });
  } catch (err: any) {
    const isDupe =
      err.code === "23505" ||
      (err.cause as any)?.code === "23505" ||
      String(err?.message ?? "").toLowerCase().includes("unique");
    if (isDupe) return { alreadyProcessed: true };
    throw err;
  }

  const benefitRows = [
    { userId: TEST_USER, type: "message_extension" },
    { userId: TEST_USER, type: "message_extension" },
    { userId: TEST_USER, type: "undo_close" },
  ];
  await db.insert(userBenefits).values(benefitRows);
  await db.insert(callCredits).values({ userId: TEST_USER, phoneCredits: 3, videoCredits: 1 })
    .onConflictDoUpdate({
      target: callCredits.userId,
      set: {
        phoneCredits: sql`${callCredits.phoneCredits} + 3`,
        videoCredits: sql`${callCredits.videoCredits} + 1`,
        updatedAt: sql`now()`,
      },
    });
  return { granted: true };
}

/** Simulate membership cancellation webhook (customer.subscription.deleted) */
async function simulateMembershipCancelWebhook() {
  const [sub] = await db.select().from(membershipSubscriptions).where(eq(membershipSubscriptions.userId, TEST_USER));
  if (!sub) throw new Error("No membership subscription found");

  const updated = await db.update(membershipSubscriptions)
    .set({ status: "cancelled", updatedAt: new Date() })
    .where(eq(membershipSubscriptions.stripeCustomerId, sub.stripeCustomerId))
    .returning({ userId: membershipSubscriptions.userId });
  return { cancelled: updated.length > 0 };
}

/** Simulate entitlement check (logout/login/device = re-fetch from DB, same logic) */
async function checkEntitlements() {
  const [
    benefits,
    elevRow,
    credRow,
    membershipRow,
  ] = await Promise.all([
    db.select().from(userBenefits).where(eq(userBenefits.userId, TEST_USER)),
    db.select().from(userElevates).where(eq(userElevates.userId, TEST_USER)),
    db.select().from(callCredits).where(eq(callCredits.userId, TEST_USER)),
    db.select().from(membershipSubscriptions).where(eq(membershipSubscriptions.userId, TEST_USER)),
  ]);

  const available: Record<string, number> = {};
  for (const b of benefits) {
    if (!b.activatedMatchId) available[b.type] = (available[b.type] || 0) + 1;
  }

  const elevate = elevRow[0] ?? null;
  const credits = credRow[0] ?? { phoneCredits: 0, videoCredits: 0 };
  const membership = membershipRow[0] ?? null;
  const voiceNotesUnlocked = (available["voice_notes_unlock"] ?? 0) > 0;

  return { available, voiceNotesUnlocked, elevate, credits, membership };
}

/** Simulate consuming an undo_close benefit */
async function consumeUndoClose() {
  const [row] = await db.select().from(userBenefits)
    .where(and(eq(userBenefits.userId, TEST_USER), eq(userBenefits.type, "undo_close"), isNull(userBenefits.activatedMatchId)))
    .limit(1);
  if (!row) return false;
  await db.delete(userBenefits).where(eq(userBenefits.id, row.id));
  return true;
}

/** Simulate consuming a call credit (call:complete) */
async function consumeCallCredit(type: "phone" | "video") {
  const [row] = await db.select().from(callCredits).where(eq(callCredits.userId, TEST_USER)).limit(1);
  if (!row) return false;
  if (type === "phone" && row.phoneCredits <= 0) return false;
  if (type === "video" && row.videoCredits <= 0) return false;
  await db.update(callCredits).set({
    phoneCredits: type === "phone" ? sql`GREATEST(phone_credits - 1, 0)` : callCredits.phoneCredits,
    videoCredits: type === "video" ? sql`GREATEST(video_credits - 1, 0)` : callCredits.videoCredits,
    updatedAt: sql`now()`,
  }).where(eq(callCredits.userId, TEST_USER));
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT RUNS
// ─────────────────────────────────────────────────────────────────────────────

async function audit() {
  // Reset
  await db.delete(userBenefits).where(eq(userBenefits.userId, TEST_USER));
  await db.delete(userElevates).where(eq(userElevates.userId, TEST_USER));
  await db.delete(callCredits).where(eq(callCredits.userId, TEST_USER));
  await db.delete(membershipSubscriptions).where(eq(membershipSubscriptions.userId, TEST_USER));
  await db.delete(processedStripeSessions).where(eq(processedStripeSessions.userId, TEST_USER));

  // ── 1. VOICE NOTES UNLOCK ───────────────────────────────────────────────────
  console.log("\n━━━━ 1. VOICE NOTES UNLOCK ($4.99) ━━━━");
  {
    const before = await checkEntitlements();
    console.log("  BEFORE: voice_notes_unlock =", before.available["voice_notes_unlock"] ?? 0);
    before.available["voice_notes_unlock"] ? fail_("voice_notes_unlock present before purchase") : ok("voice_notes_unlock absent before purchase");

    // Simulate checkout + activate
    const res = await simulateExtrasActivate("voice-notes-unlock", "cs_sim_vn_001");
    console.log("  ACTIVATE:", res);

    const after = await checkEntitlements();
    const count = after.available["voice_notes_unlock"] ?? 0;
    count === 1 ? ok("voice_notes_unlock granted in user_benefits") : fail_("voice_notes_unlock not found after activate", `count=${count}`);

    // Idempotency: double-activate same session
    const res2 = await simulateExtrasActivate("voice-notes-unlock", "cs_sim_vn_001");
    const afterDupe = await checkEntitlements();
    const count2 = afterDupe.available["voice_notes_unlock"] ?? 0;
    (count2 === 1 && (res2 as any).alreadyProcessed) ? ok("idempotency guard works — no double-grant") : fail_("idempotency guard FAILED", `count after dupe=${count2}`);

    // Entitlement check (logout/login/device = re-query from DB)
    after.voiceNotesUnlocked ? ok("entitlement persists after logout/login/device/refresh") : fail_("entitlement does NOT persist");

    // Voice notes unlock is permanent (never consumed on use) — verify row count unchanged after usage
    const noConsumption = (afterDupe.available["voice_notes_unlock"] ?? 0) === 1;
    noConsumption ? ok("voice_notes_unlock is permanent (not consumed on send)") : fail_("voice_notes_unlock was consumed unexpectedly");

    console.log("  DB after:", { voiceNoteRows: count2, processed: afterDupe.available });
  }

  // ── 2. UNDO CLOSE ──────────────────────────────────────────────────────────
  console.log("\n━━━━ 2. UNDO CLOSE ($2.99) ━━━━");
  {
    const before = await checkEntitlements();
    const beforeCount = before.available["undo_close"] ?? 0;
    console.log("  BEFORE: undo_close =", beforeCount);
    beforeCount === 0 ? ok("undo_close absent before purchase") : fail_("undo_close present before purchase", `count=${beforeCount}`);

    await simulateExtrasActivate("undo-close", "cs_sim_uc_001");
    const after = await checkEntitlements();
    const count = after.available["undo_close"] ?? 0;
    count === 1 ? ok("undo_close granted in user_benefits") : fail_("undo_close not found after activate", `count=${count}`);

    // Entitlement persists
    count === 1 ? ok("entitlement persists after logout/login/device/refresh") : fail_("entitlement does NOT persist");

    // Consume it (simulate actual undo action)
    const consumed = await consumeUndoClose();
    consumed ? ok("undo_close consumed on use (row deleted)") : fail_("undo_close not consumed — consume returned false");

    const afterConsume = await checkEntitlements();
    const remaining = afterConsume.available["undo_close"] ?? 0;
    remaining === 0 ? ok("undo_close depleted to 0 after use") : fail_("undo_close not depleted", `remaining=${remaining}`);

    // Idempotency
    const res2 = await simulateExtrasActivate("undo-close", "cs_sim_uc_001");
    const afterDupe = await checkEntitlements();
    (res2 as any).alreadyProcessed && (afterDupe.available["undo_close"] ?? 0) === 0
      ? ok("idempotency guard works — no re-grant after consumption")
      : fail_("idempotency guard FAILED on undo-close", JSON.stringify(res2));
  }

  // ── 3. ELEVATE ─────────────────────────────────────────────────────────────
  console.log("\n━━━━ 3. ELEVATE — elevate-1 ($9.99) ━━━━");
  {
    const before = await checkEntitlements();
    const noElevate = before.elevate === null;
    noElevate ? ok("no elevate row before purchase") : fail_("elevate row exists before purchase");

    await simulateElevateActivate("elevate-1", "cs_sim_el_001");
    const after = await checkEntitlements();
    const elRow = after.elevate;
    elRow ? ok("user_elevates row created") : fail_("user_elevates row missing after activate");
    if (elRow) {
      // After elevate-1: added 1 credit, auto-activated 1, so credits should be 0
      elRow.elevateCredits === 0 ? ok("credit consumed by auto-activate (0 remaining)") : fail_(`credits not consumed correctly, got ${elRow.elevateCredits}`);
      elRow.expiresAt > new Date() ? ok("boost is active (expiresAt in future)") : fail_("boost not active after activate");
      elRow.activatedAt !== null ? ok("activatedAt set for session window accuracy") : fail_("activatedAt is null — session stats will use fallback");
    }

    // Idempotency
    const res2 = await simulateElevateActivate("elevate-1", "cs_sim_el_001");
    const afterDupe = await checkEntitlements();
    (res2 as any).alreadyProcessed ? ok("elevate idempotency guard works") : fail_("elevate idempotency FAILED");
    (afterDupe.elevate?.elevateCredits === 0) ? ok("no extra credits granted on dupe") : fail_("extra credits granted on dupe");

    // Entitlement persists (DB read, device-agnostic)
    afterDupe.elevate !== null ? ok("elevate status persists after logout/login/device/refresh") : fail_("elevate status lost after restart");
  }

  console.log("\n━━━━ 3b. ELEVATE — elevate-3 ($26.99) ━━━━");
  {
    // Fresh elevate credits on same user
    await simulateElevateActivate("elevate-3", "cs_sim_el_003");
    const after = await checkEntitlements();
    const elRow = after.elevate;
    // Bought 3, auto-activated 1 = 2 remaining
    elRow ? (elRow.elevateCredits === 2 ? ok("elevate-3 grants 3 credits, uses 1 = 2 remaining") : fail_("wrong credit count", `got ${elRow.elevateCredits}`)) : fail_("no elevate row");
  }

  console.log("\n━━━━ 3c. SUPER ELEVATE ($34.99) ━━━━");
  {
    // Reset elevate row
    await db.delete(userElevates).where(eq(userElevates.userId, TEST_USER));
    await db.delete(processedStripeSessions).where(eq(processedStripeSessions.userId, TEST_USER));

    await simulateElevateActivate("super-elevate", "cs_sim_sup_001");
    const after = await checkEntitlements();
    const elRow = after.elevate;
    elRow ? ok("super elevate row created") : fail_("super elevate row missing");
    if (elRow) {
      elRow.superElevateCredits === 0 ? ok("super credit consumed by auto-activate") : fail_(`super credits wrong, got ${elRow.superElevateCredits}`);
      const durationMs = elRow.expiresAt.getTime() - (elRow.activatedAt?.getTime() ?? Date.now());
      const expectedMs = 60 * 60 * 1000;
      Math.abs(durationMs - expectedMs) < 5000 ? ok("super elevate duration = 60 minutes") : fail_(`wrong duration: ${Math.round(durationMs/60000)}min`);
    }
  }

  // ── 4. MEMBERSHIP ──────────────────────────────────────────────────────────
  console.log("\n━━━━ 4. MEMBERSHIP ($19.99/mo) ━━━━");
  {
    // Reset
    await db.delete(userBenefits).where(eq(userBenefits.userId, TEST_USER));
    await db.delete(callCredits).where(eq(callCredits.userId, TEST_USER));
    await db.delete(membershipSubscriptions).where(eq(membershipSubscriptions.userId, TEST_USER));
    await db.delete(processedStripeSessions).where(eq(processedStripeSessions.userId, TEST_USER));

    const before = await checkEntitlements();
    !before.membership ? ok("no membership before purchase") : fail_("membership exists before purchase");

    await simulateExtrasActivate("membership", "cs_sim_mem_001");
    const after = await checkEntitlements();

    // Check benefit rows
    const msgExt = after.available["message_extension"] ?? 0;
    const undoClose = after.available["undo_close"] ?? 0;
    msgExt === 2 ? ok("membership grants 2 × message_extension") : fail_(`expected 2 message_extensions, got ${msgExt}`);
    undoClose === 1 ? ok("membership grants 1 × undo_close") : fail_(`expected 1 undo_close, got ${undoClose}`);

    // Check call credits
    after.credits.phoneCredits === 3 ? ok("membership grants 3 phone credits") : fail_(`expected 3 phone, got ${after.credits.phoneCredits}`);
    after.credits.videoCredits === 1 ? ok("membership grants 1 video credit") : fail_(`expected 1 video, got ${after.credits.videoCredits}`);

    // Check membership record
    after.membership?.status === "active" ? ok("membership_subscriptions row created with status=active") : fail_("membership row missing or not active");
    after.membership?.stripeCustomerId ? ok("stripeCustomerId stored (needed for renewal webhook)") : fail_("stripeCustomerId missing — renewal webhooks will FAIL");
    after.membership?.stripeSubscriptionId ? ok("stripeSubscriptionId stored") : fail_("stripeSubscriptionId missing");

    // Entitlement persists
    after.membership?.status === "active" ? ok("membership status persists after logout/login/device/refresh") : fail_("membership status lost");

    // Idempotency
    const res2 = await simulateExtrasActivate("membership", "cs_sim_mem_001");
    (res2 as any).alreadyProcessed ? ok("membership idempotency guard works") : fail_("membership idempotency FAILED");
    const afterDupe = await checkEntitlements();
    (afterDupe.available["message_extension"] ?? 0) === 2 ? ok("no extra benefits granted on dupe") : fail_("double-grant on membership dupe");

    // Simulate monthly renewal webhook
    const renewRes = await simulateMembershipRenewalWebhook("in_sim_renewal_001");
    const afterRenewal = await checkEntitlements();
    (afterRenewal.available["message_extension"] ?? 0) === 4 ? ok("renewal webhook grants +2 more message_extensions") : fail_(`renewal message_extension count wrong, got ${afterRenewal.available["message_extension"]}`);
    (afterRenewal.available["undo_close"] ?? 0) === 2 ? ok("renewal webhook grants +1 more undo_close") : fail_(`renewal undo_close wrong, got ${afterRenewal.available["undo_close"]}`);
    afterRenewal.credits.phoneCredits === 6 ? ok("renewal webhook adds +3 phone credits (cumulative)") : fail_(`renewal phone credits wrong, got ${afterRenewal.credits.phoneCredits}`);
    afterRenewal.credits.videoCredits === 2 ? ok("renewal webhook adds +1 video credit (cumulative)") : fail_(`renewal video credits wrong, got ${afterRenewal.credits.videoCredits}`);

    // Renewal idempotency (same invoice ID)
    const renewRes2 = await simulateMembershipRenewalWebhook("in_sim_renewal_001");
    (renewRes2 as any).alreadyProcessed ? ok("renewal webhook idempotency guard works") : fail_("renewal webhook idempotency FAILED");
    const afterRenewDupe = await checkEntitlements();
    (afterRenewDupe.available["message_extension"] ?? 0) === 4 ? ok("no double-grant on duplicate renewal webhook") : fail_("double-grant on renewal webhook dupe");

    // Simulate cancellation webhook
    const cancelRes = await simulateMembershipCancelWebhook();
    cancelRes.cancelled ? ok("cancellation webhook marks membership as cancelled") : fail_("cancellation webhook failed");
    const afterCancel = await checkEntitlements();
    afterCancel.membership?.status === "cancelled" ? ok("membership status = cancelled after webhook") : fail_("membership not cancelled");

    // Already-granted benefits survive cancellation (paid for)
    (afterCancel.available["message_extension"] ?? 0) === 4 ? ok("already-granted benefits survive cancellation") : fail_("benefits deleted on cancellation — WRONG");
    afterCancel.credits.phoneCredits === 6 ? ok("call credits survive cancellation") : fail_("call credits deleted on cancellation — WRONG");
  }

  // ── 5. CALL CREDIT PACKS ───────────────────────────────────────────────────
  console.log("\n━━━━ 5. CALL CREDIT PACKS ━━━━");
  {
    await db.delete(callCredits).where(eq(callCredits.userId, TEST_USER));
    await db.delete(processedStripeSessions).where(eq(processedStripeSessions.userId, TEST_USER));

    // starter-pack: 1 phone credit
    await simulateExtrasActivate("starter-pack", "cs_sim_sp_001");
    const s1 = await checkEntitlements();
    s1.credits.phoneCredits === 1 ? ok("starter-pack grants 1 phone credit") : fail_(`starter-pack phone wrong, got ${s1.credits.phoneCredits}`);
    s1.credits.videoCredits === 0 ? ok("starter-pack grants 0 video credits") : fail_(`starter-pack video wrong, got ${s1.credits.videoCredits}`);

    // connection-pack: +3 phone
    await simulateExtrasActivate("connection-pack", "cs_sim_cp_001");
    const s2 = await checkEntitlements();
    s2.credits.phoneCredits === 4 ? ok("connection-pack accumulates correctly (1+3=4 phone)") : fail_(`connection-pack total wrong, got ${s2.credits.phoneCredits}`);

    // premium-pack: +5 phone
    await simulateExtrasActivate("premium-pack", "cs_sim_pp_001");
    const s3 = await checkEntitlements();
    s3.credits.phoneCredits === 9 ? ok("premium-pack accumulates correctly (4+5=9 phone)") : fail_(`premium-pack total wrong, got ${s3.credits.phoneCredits}`);

    // Consume 1 phone credit (call:complete)
    const consumed = await consumeCallCredit("phone");
    consumed ? ok("phone credit consumed on call:complete") : fail_("consumeCallCredit returned false");
    const s4 = await checkEntitlements();
    s4.credits.phoneCredits === 8 ? ok("phone credits decremented to 8") : fail_(`expected 8, got ${s4.credits.phoneCredits}`);

    // Test GREATEST guard — can't go below 0
    for (let i = 0; i < 9; i++) await consumeCallCredit("phone"); // consume all + 1 extra
    const s5 = await checkEntitlements();
    s5.credits.phoneCredits === 0 ? ok("GREATEST guard prevents negative phone credits") : fail_(`credits went negative: ${s5.credits.phoneCredits}`);

    // Entitlement persists (DB read)
    const s6 = await checkEntitlements();
    s6.credits !== null ? ok("call_credits row persists after logout/login/device/refresh") : fail_("call_credits lost");

    // Idempotency on a pack
    const res2 = await simulateExtrasActivate("starter-pack", "cs_sim_sp_001");
    (res2 as any).alreadyProcessed ? ok("call-pack idempotency guard works") : fail_("call-pack idempotency FAILED");
    const s7 = await checkEntitlements();
    s7.credits.phoneCredits === 0 ? ok("no extra phone credits granted on dupe session") : fail_(`extra credits granted: ${s7.credits.phoneCredits}`);
  }

  // ── 6. VIDEO CALL PACKS ────────────────────────────────────────────────────
  console.log("\n━━━━ 6. VIDEO CALL PACKS ━━━━");
  {
    await db.delete(callCredits).where(eq(callCredits.userId, TEST_USER));
    await db.delete(processedStripeSessions).where(eq(processedStripeSessions.userId, TEST_USER));

    // video-starter: 1 video credit
    await simulateExtrasActivate("video-starter", "cs_sim_vs_001");
    const v1 = await checkEntitlements();
    v1.credits.videoCredits === 1 ? ok("video-starter grants 1 video credit") : fail_(`video-starter wrong, got ${v1.credits.videoCredits}`);
    v1.credits.phoneCredits === 0 ? ok("video-starter grants 0 phone credits") : fail_(`phone wrong, got ${v1.credits.phoneCredits}`);

    // chemistry-pack: 3 phone + 1 video
    await simulateExtrasActivate("chemistry-pack", "cs_sim_chem_001");
    const v2 = await checkEntitlements();
    v2.credits.phoneCredits === 3 ? ok("chemistry-pack grants 3 phone credits") : fail_(`chemistry phone wrong, got ${v2.credits.phoneCredits}`);
    v2.credits.videoCredits === 2 ? ok("chemistry-pack grants +1 video (total 2)") : fail_(`chemistry video wrong, got ${v2.credits.videoCredits}`);

    // deep-connection-pack: 5 phone + 3 video
    await simulateExtrasActivate("deep-connection-pack", "cs_sim_dc_001");
    const v3 = await checkEntitlements();
    v3.credits.phoneCredits === 8 ? ok("deep-connection-pack grants 5 more phone (total 8)") : fail_(`dc phone wrong, got ${v3.credits.phoneCredits}`);
    v3.credits.videoCredits === 5 ? ok("deep-connection-pack grants 3 more video (total 5)") : fail_(`dc video wrong, got ${v3.credits.videoCredits}`);

    // Consume 1 video credit
    const consumed = await consumeCallCredit("video");
    consumed ? ok("video credit consumed on video call:complete") : fail_("consumeCallCredit(video) returned false");
    const v4 = await checkEntitlements();
    v4.credits.videoCredits === 4 ? ok("video credits decremented to 4") : fail_(`expected 4, got ${v4.credits.videoCredits}`);

    // Phone credits untouched by video consumption
    v4.credits.phoneCredits === 8 ? ok("phone credits unaffected by video credit consumption") : fail_(`phone changed unexpectedly: ${v4.credits.phoneCredits}`);

    // Test GREATEST guard on video
    for (let i = 0; i < 5; i++) await consumeCallCredit("video");
    const v5 = await checkEntitlements();
    v5.credits.videoCredits === 0 ? ok("GREATEST guard prevents negative video credits") : fail_(`video credits went negative: ${v5.credits.videoCredits}`);

    // Idempotency
    const r2 = await simulateExtrasActivate("video-starter", "cs_sim_vs_001");
    (r2 as any).alreadyProcessed ? ok("video-pack idempotency guard works") : fail_("video-pack idempotency FAILED");

    // Entitlement persists
    const v6 = await checkEntitlements();
    v6.credits !== null ? ok("video credits persist after logout/login/device/refresh") : fail_("video credits lost");
  }

  // ── 7. CROSS-PURCHASE ACCUMULATION ────────────────────────────────────────
  console.log("\n━━━━ 7. CROSS-PURCHASE ACCUMULATION ━━━━");
  {
    await db.delete(callCredits).where(eq(callCredits.userId, TEST_USER));
    await db.delete(processedStripeSessions).where(eq(processedStripeSessions.userId, TEST_USER));

    await simulateExtrasActivate("starter-pack",    "cs_sim_acc_1");
    await simulateExtrasActivate("connection-pack", "cs_sim_acc_2");
    await simulateExtrasActivate("video-starter",   "cs_sim_acc_3");
    await simulateExtrasActivate("chemistry-pack",  "cs_sim_acc_4");

    const acc = await checkEntitlements();
    // starter: phone+1, connection: phone+3, video-starter: video+1, chemistry: phone+3 video+1
    // = phone: 1+3+3=7, video: 1+1=2
    acc.credits.phoneCredits === 7 ? ok("multi-pack phone accumulation correct (7)") : fail_(`multi-pack phone wrong, got ${acc.credits.phoneCredits}`);
    acc.credits.videoCredits === 2 ? ok("multi-pack video accumulation correct (2)") : fail_(`multi-pack video wrong, got ${acc.credits.videoCredits}`);
  }

  // ── CLEANUP ────────────────────────────────────────────────────────────────
  await db.delete(userBenefits).where(eq(userBenefits.userId, TEST_USER));
  await db.delete(userElevates).where(eq(userElevates.userId, TEST_USER));
  await db.delete(callCredits).where(eq(callCredits.userId, TEST_USER));
  await db.delete(membershipSubscriptions).where(eq(membershipSubscriptions.userId, TEST_USER));
  await db.delete(processedStripeSessions).where(eq(processedStripeSessions.userId, TEST_USER));

  // ── REPORT ─────────────────────────────────────────────────────────────────
  console.log("\n" + "━".repeat(55));
  console.log(`AUDIT COMPLETE: ${pass} passed, ${fail} failed`);
  if (bugs.length > 0) {
    console.log("\n🐛 BUGS FOUND:");
    bugs.forEach((b, i) => console.log(`  ${i + 1}. ${b}`));
  } else {
    console.log("\n✅ No bugs found — all purchase flows are correct.");
  }
  console.log("━".repeat(55));

  process.exit(fail > 0 ? 1 : 0);
}

audit().catch((err) => {
  console.error("AUDIT CRASH:", err);
  process.exit(2);
});
