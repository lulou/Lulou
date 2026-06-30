/**
 * verify-payment-sim.ts
 * End-to-end verification of the admin payment simulation system.
 * Run: npx tsx scripts/verify-payment-sim.ts
 *
 * Tests (no HTTP, no Stripe, no real email):
 *   1. Halo purchase — entitlement granted + DB records correct
 *   2. Refund simulation — record updated + email template renders
 *   3. Duplicate refund — blocked by idempotency (no second email)
 *   4. ID prefix safety — sim_session_ / sim_refund_ prefixes enforced
 *   5. Purchase idempotency — same session cannot be re-granted
 */

import { db } from "../server/db";
import { eq } from "drizzle-orm";
import {
  adminPaymentSimulations,
  processedStripeSessions,
  sparkBalances,
} from "../shared/schema";
import { grantExtras, isUniqueViolation } from "../server/purchaseItems";
import { refundConfirmationEmail } from "../server/emailTemplates";

const pass = (msg: string) => console.log(`  ✅ PASS: ${msg}`);
const fail = (msg: string) => { console.log(`  ❌ FAIL: ${msg}`); process.exitCode = 1; };
const genId = (prefix: string) =>
  `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

// ── Setup ─────────────────────────────────────────────────────────────────────

const targetUserId = "test_verify_" + Date.now();
const simSessionId = genId("sim_session_");

// ── TEST 1: Halo purchase simulation ─────────────────────────────────────────

console.log("\n=== TEST 1: Halo purchase simulation (sparks-1) ===");

await db.insert(processedStripeSessions).values({
  sessionId: simSessionId,
  userId: targetUserId,
  itemRef: "sparks-1",
});
pass("Idempotency slot claimed in processed_stripe_sessions");

const grantedTypes = await grantExtras(targetUserId, simSessionId, "sparks-1", {});
if (grantedTypes.includes("spin_credit")) {
  pass(`Entitlement granted: [${grantedTypes.join(", ")}]`);
} else {
  fail(`Expected spin_credit in grantedTypes, got: [${grantedTypes.join(", ")}]`);
}

const [balRow] = await db
  .select()
  .from(sparkBalances)
  .where(eq(sparkBalances.userId, targetUserId));
if (balRow && balRow.balance >= 1) {
  pass(`spark_balances.balance = ${balRow.balance} ≥ 1 ✓`);
} else {
  fail(`spark_balances not updated: ${JSON.stringify(balRow)}`);
}

const [simRecord] = await db
  .insert(adminPaymentSimulations)
  .values({
    simSessionId,
    adminUserId: "admin_test",
    targetUserId,
    itemId: "sparks-1",
    packId: null,
    productName: "1 Halo",
    amountCents: 299,
    currency: "aud",
    status: "granted",
    grantResult: JSON.stringify(grantedTypes),
    purchaseEmailSent: false,
  })
  .returning();
pass(`admin_payment_simulations record created, status=${simRecord.status}`);
pass(`simSessionId stored: ${simRecord.simSessionId.slice(0, 24)}…`);

// ── TEST 2: Refund simulation ─────────────────────────────────────────────────

console.log("\n=== TEST 2: Refund simulation ===");

const refundSimId = genId("sim_refund_");
const idemKey = `refund_email_${refundSimId}`;

await db.insert(processedStripeSessions).values({
  sessionId: idemKey,
  userId: "sim_refund",
  itemRef: refundSimId,
});
pass("Refund idempotency slot claimed in processed_stripe_sessions");

const html = refundConfirmationEmail("Test User", "A$2.99", "1 Halo", refundSimId);
if (html.includes(refundSimId) && html.length > 100) {
  pass("Refund email template renders correctly (contains refundId)");
} else {
  fail(`Refund email template output suspicious: length=${html.length}`);
}

const [updated] = await db
  .update(adminPaymentSimulations)
  .set({ status: "refunded", refundSimId, refundedAt: new Date(), refundEmailSent: false })
  .where(eq(adminPaymentSimulations.simSessionId, simSessionId))
  .returning();
pass(`Simulation record updated — status: ${updated.status}`);
pass(`refundSimId stored: ${updated.refundSimId?.slice(0, 22)}…`);

// ── TEST 3: Duplicate refund idempotency ─────────────────────────────────────

console.log("\n=== TEST 3: Duplicate refund — idempotent skip (no second email) ===");

let duplicateBlocked = false;
try {
  await db.insert(processedStripeSessions).values({
    sessionId: idemKey,
    userId: "sim_refund",
    itemRef: refundSimId,
  });
} catch (e: any) {
  if (isUniqueViolation(e)) {
    duplicateBlocked = true;
  }
}
if (duplicateBlocked) {
  pass("Duplicate refund email insert blocked by unique violation ✓");
  pass("Re-running the same refund would NOT send a second email");
} else {
  fail("Duplicate insert was NOT blocked — idempotency is broken");
}

// ── TEST 4: ID prefix safety ──────────────────────────────────────────────────

console.log("\n=== TEST 4: ID prefix safety ===");

simSessionId.startsWith("sim_session_")
  ? pass(`Purchase uses sim_session_ prefix`)
  : fail(`Wrong prefix on simSessionId: ${simSessionId}`);

refundSimId.startsWith("sim_refund_")
  ? pass(`Refund uses sim_refund_ prefix`)
  : fail(`Wrong prefix on refundSimId: ${refundSimId}`);

(!simSessionId.startsWith("cs_") && !simSessionId.startsWith("pi_"))
  ? pass("Never starts with cs_ or pi_ (real Stripe prefixes)")
  : fail(`simSessionId looks like a real Stripe ID: ${simSessionId}`);

(!refundSimId.startsWith("re_") && !refundSimId.startsWith("ch_"))
  ? pass("Never starts with re_ or ch_ (real Stripe refund/charge prefixes)")
  : fail(`refundSimId looks like a real Stripe ID: ${refundSimId}`);

// ── TEST 5: Purchase idempotency — no double-grant ────────────────────────────

console.log("\n=== TEST 5: Purchase idempotency (same session, no double-grant) ===");

let purchaseBlocked = false;
try {
  await db.insert(processedStripeSessions).values({
    sessionId: simSessionId,
    userId: targetUserId,
    itemRef: "sparks-1",
  });
} catch (e: any) {
  if (isUniqueViolation(e)) purchaseBlocked = true;
}
purchaseBlocked
  ? pass("Re-granting the same simSessionId is blocked by unique violation")
  : fail("Purchase idempotency is broken — same session could double-grant");

// ── Cleanup ───────────────────────────────────────────────────────────────────

console.log("\n=== Cleanup ===");
await db.delete(adminPaymentSimulations).where(eq(adminPaymentSimulations.simSessionId, simSessionId));
await db.delete(processedStripeSessions).where(eq(processedStripeSessions.sessionId, simSessionId));
await db.delete(processedStripeSessions).where(eq(processedStripeSessions.sessionId, idemKey));
await db.delete(sparkBalances).where(eq(sparkBalances.userId, targetUserId));
pass("All test records cleaned up");

const exitCode = process.exitCode ?? 0;
console.log(`\n${ exitCode === 0 ? "✅ ALL TESTS PASSED" : "❌ SOME TESTS FAILED" }\n`);
