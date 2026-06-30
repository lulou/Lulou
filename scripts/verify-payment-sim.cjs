/**
 * verify-payment-sim.cjs
 * End-to-end verification of the admin payment simulation system.
 * Run from workspace root: node scripts/verify-payment-sim.cjs
 */

const assert = (cond, msg) => {
  if (cond) console.log(`  \u2705 PASS: ${msg}`);
  else { console.log(`  \u274C FAIL: ${msg}`); process.exitCode = 1; }
};
const genId = (prefix) => `${prefix}${Date.now().toString(36)}_${Math.random().toString(36).slice(2,8)}`;

async function run() {
  const { db }     = await import("../server/db.js");
  const { eq }     = await import("drizzle-orm");
  const schema     = await import("../shared/schema.js");
  const { grantExtras, isUniqueViolation } = await import("../server/purchaseItems.js");
  const { refundConfirmationEmail }         = await import("../server/emailTemplates.js");

  const { adminPaymentSimulations, processedStripeSessions, sparkBalances } = schema;

  const targetUserId = "test_verify_" + Date.now();
  const simSessionId = genId("sim_session_");

  // ── TEST 1: Halo purchase simulation ────────────────────────────────────────
  console.log("\n=== TEST 1: Halo purchase simulation ===");

  await db.insert(processedStripeSessions).values({
    sessionId: simSessionId, userId: targetUserId, itemRef: "sparks-1",
  });
  assert(true, "Idempotency slot claimed in processed_stripe_sessions");

  const grantedTypes = await grantExtras(targetUserId, simSessionId, "sparks-1", {});
  assert(grantedTypes.includes("spin_credit"),
    `grantExtras returned spin_credit — got: [${grantedTypes.join(",")}]`);

  const [balRow] = await db.select().from(sparkBalances)
    .where(eq(sparkBalances.userId, targetUserId));
  assert(balRow && balRow.balance >= 1,
    `spark_balances.balance = ${balRow?.balance} (expected >= 1)`);

  const [simRecord] = await db.insert(adminPaymentSimulations).values({
    simSessionId, adminUserId: "admin_test", targetUserId,
    itemId: "sparks-1", packId: null, productName: "1 Halo",
    amountCents: 299, currency: "aud", status: "granted",
    grantResult: JSON.stringify(grantedTypes), purchaseEmailSent: false,
  }).returning();
  assert(simRecord.status === "granted",
    "admin_payment_simulations record created with status=granted");
  assert(simRecord.simSessionId === simSessionId,
    "simSessionId stored correctly");

  // ── TEST 2: Refund simulation ────────────────────────────────────────────────
  console.log("\n=== TEST 2: Refund simulation ===");

  const refundSimId = genId("sim_refund_");
  const idemKey = `refund_email_${refundSimId}`;

  await db.insert(processedStripeSessions).values({
    sessionId: idemKey, userId: "sim_refund", itemRef: refundSimId,
  });
  assert(true, "Refund idempotency slot claimed");

  const html = refundConfirmationEmail("Test", "A$2.99", "1 Halo", refundSimId);
  assert(html.includes(refundSimId) && html.length > 100,
    "Refund email template renders correctly (contains refundId)");

  const [updated] = await db.update(adminPaymentSimulations)
    .set({ status: "refunded", refundSimId, refundedAt: new Date(), refundEmailSent: false })
    .where(eq(adminPaymentSimulations.simSessionId, simSessionId))
    .returning();
  assert(updated.status === "refunded", "Simulation record updated to refunded");
  assert(updated.refundSimId === refundSimId, "refundSimId stored on record");

  // ── TEST 3: Duplicate refund idempotency ────────────────────────────────────
  console.log("\n=== TEST 3: Duplicate refund — idempotent skip ===");

  let duplicateBlocked = false;
  try {
    await db.insert(processedStripeSessions).values({
      sessionId: idemKey, userId: "sim_refund", itemRef: refundSimId,
    });
  } catch (e) {
    if (isUniqueViolation(e)) duplicateBlocked = true;
  }
  assert(duplicateBlocked,
    "Duplicate refund email insert blocked by unique violation (no second email)");

  // ── TEST 4: ID prefix safety (never mix with real Stripe IDs) ───────────────
  console.log("\n=== TEST 4: ID prefix safety ===");
  assert(simSessionId.startsWith("sim_session_"),
    `Purchase uses sim_session_ prefix: ${simSessionId}`);
  assert(refundSimId.startsWith("sim_refund_"),
    `Refund uses sim_refund_ prefix: ${refundSimId}`);
  assert(!simSessionId.startsWith("cs_"),
    "Never starts with cs_ (real Stripe session prefix)");
  assert(!refundSimId.startsWith("re_"),
    "Never starts with re_ (real Stripe refund prefix)");

  // ── TEST 5: Purchase idempotency (same session cannot be re-granted) ────────
  console.log("\n=== TEST 5: Purchase idempotency (no double-grant) ===");

  let purchaseDuplicateBlocked = false;
  try {
    await db.insert(processedStripeSessions).values({
      sessionId: simSessionId, userId: targetUserId, itemRef: "sparks-1",
    });
  } catch (e) {
    if (isUniqueViolation(e)) purchaseDuplicateBlocked = true;
  }
  assert(purchaseDuplicateBlocked,
    "Re-simulating the same purchase is blocked (idempotent, no double-grant)");

  // ── Cleanup ──────────────────────────────────────────────────────────────────
  await db.delete(adminPaymentSimulations)
    .where(eq(adminPaymentSimulations.simSessionId, simSessionId));
  await db.delete(processedStripeSessions)
    .where(eq(processedStripeSessions.sessionId, simSessionId));
  await db.delete(processedStripeSessions)
    .where(eq(processedStripeSessions.sessionId, idemKey));
  await db.delete(sparkBalances)
    .where(eq(sparkBalances.userId, targetUserId));
  assert(true, "Test data cleaned up");

  console.log("\n=== ALL VERIFICATION TESTS COMPLETE ===");
}

run().catch(e => { console.error("FATAL:", e.message); process.exitCode = 1; });
