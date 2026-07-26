/**
 * Progression system tests — Task #64
 *
 * Covers:
 *   1. Threshold tests   — >= 8 (VN) and >= 15 (FC) fire on crossing, not only on ===
 *   2. Concurrency tests — two concurrent atomic increments never lose a count
 *   3. Reconciliation    — the repair logic recounts from messages and caps at 15
 *   4. Exclusion         — __ prefixed system payloads are not counted
 *
 * Run:  npx tsx scripts/test-progression.ts
 * Exit: 0 = all PASS, 1 = one or more FAIL
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { eq, and, sql as sqlExpr } from "drizzle-orm";
import * as schema from "../shared/schema";

const { matches, messages, voiceNoteUnlocks } = schema;

if (!process.env.DATABASE_URL && !process.env.NEON_DATABASE_URL) {
  console.error("DATABASE_URL or NEON_DATABASE_URL must be set");
  process.exit(1);
}
const connStr = (process.env.DATABASE_URL ?? process.env.NEON_DATABASE_URL)!;
const pool = new Pool({ connectionString: connStr, max: 10 });
const db = drizzle(pool, { schema });

// ── helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(label: string) {
  console.log(`  ✓ PASS  ${label}`);
  passed++;
}

function fail(label: string, detail?: string) {
  console.log(`  ✗ FAIL  ${label}${detail ? `  →  ${detail}` : ""}`);
  failed++;
}

function assert(condition: boolean, label: string, detail?: string) {
  if (condition) pass(label);
  else fail(label, detail);
}

const TEST_USER1 = "test-progression-u1";
const TEST_USER2 = "test-progression-u2";

async function createTestMatch(): Promise<string> {
  const id = `test-prog-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  await db.insert(matches).values({
    id,
    user1Id: TEST_USER1,
    user2Id: TEST_USER2,
    messageCount1: 0,
    messageCount2: 0,
    callStage: 0,
  } as any);
  return id;
}

async function cleanupMatch(matchId: string) {
  await db.delete(messages).where(eq(messages.matchId, matchId)).catch(() => {});
  await db.delete(voiceNoteUnlocks).where(eq(voiceNoteUnlocks.matchId, matchId)).catch(() => {});
  await db.delete(matches).where(eq(matches.id, matchId)).catch(() => {});
}

async function atomicIncrement(matchId: string, isUser1: boolean): Promise<{ c1: number; c2: number }> {
  const [row] = await db
    .update(matches)
    .set(isUser1
      ? { messageCount1: sqlExpr`message_count_1 + 1` }
      : { messageCount2: sqlExpr`message_count_2 + 1` })
    .where(eq(matches.id, matchId))
    .returning({ messageCount1: matches.messageCount1, messageCount2: matches.messageCount2 });
  return { c1: row?.messageCount1 ?? 0, c2: row?.messageCount2 ?? 0 };
}

async function getCounts(matchId: string): Promise<{ c1: number; c2: number }> {
  const [row] = await db
    .select({ c1: matches.messageCount1, c2: matches.messageCount2 })
    .from(matches)
    .where(eq(matches.id, matchId));
  return { c1: row?.c1 ?? 0, c2: row?.c2 ?? 0 };
}

// ── Milestone detection logic (mirrors routes.ts) ─────────────────────────────

const VN_THRESHOLD = 8;
const FC_THRESHOLD = 15;

function detectMilestone(pre1: number, pre2: number, post1: number, post2: number): string | null {
  const vnWas = pre1 >= VN_THRESHOLD && pre2 >= VN_THRESHOLD;
  const vnNow = post1 >= VN_THRESHOLD && post2 >= VN_THRESHOLD;
  const fcWas = pre1 >= FC_THRESHOLD && pre2 >= FC_THRESHOLD;
  const fcNow = post1 >= FC_THRESHOLD && post2 >= FC_THRESHOLD;
  if (vnNow && !vnWas) return "voice_notes_unlocked";
  if (fcNow && !fcWas) return "first_call_unlocked";
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 1 — Threshold tests
// ─────────────────────────────────────────────────────────────────────────────

async function runThresholdTests() {
  console.log("\n── Threshold tests ─────────────────────────────────────────");

  // 1a. VN fires exactly on the crossing message (7+7 → 8+8 in one step each)
  {
    const matchId = await createTestMatch();
    try {
      // Set both to 7 directly
      await db.update(matches)
        .set({ messageCount1: 7, messageCount2: 7 } as any)
        .where(eq(matches.id, matchId));
      const pre = await getCounts(matchId);

      // User1 sends 8th message — only user1 crosses, VN not yet eligible
      const { c1: c1a, c2: c2a } = await atomicIncrement(matchId, true);
      const m1 = detectMilestone(pre.c1, pre.c2, c1a, c2a);
      assert(m1 === null, "VN not unlocked when only user1 is at 8 (user2 still 7)");

      // User2 sends 8th message — both cross, VN unlocks
      const { c1: c1b, c2: c2b } = await atomicIncrement(matchId, false);
      const m2 = detectMilestone(c1a, c2a, c1b, c2b);
      assert(m2 === "voice_notes_unlocked", "VN unlocked when both reach 8 (7+7→8+8 exact crossing)");
    } finally {
      await cleanupMatch(matchId);
    }
  }

  // 1b. >= self-healing: if prior race left count at 9, milestone still fires on next message
  {
    const matchId = await createTestMatch();
    try {
      // Simulate skipped crossing: user1=9, user2=7 (race lost an increment on user2 at 7→8)
      await db.update(matches)
        .set({ messageCount1: 9, messageCount2: 7 } as any)
        .where(eq(matches.id, matchId));
      const pre = await getCounts(matchId);

      // User2 sends next message — goes from 7 to 8, both >=8 now — VN fires
      const { c1, c2 } = await atomicIncrement(matchId, false);
      const m = detectMilestone(pre.c1, pre.c2, c1, c2);
      assert(m === "voice_notes_unlocked", ">= self-healing: VN fires when user2 crosses 8 even though user1 is at 9");
    } finally {
      await cleanupMatch(matchId);
    }
  }

  // 1c. No double-fire: VN already eligible, next message does not re-emit
  {
    const matchId = await createTestMatch();
    try {
      await db.update(matches)
        .set({ messageCount1: 8, messageCount2: 9 } as any)
        .where(eq(matches.id, matchId));
      const pre = await getCounts(matchId);
      const { c1, c2 } = await atomicIncrement(matchId, true); // user1: 8→9
      const m = detectMilestone(pre.c1, pre.c2, c1, c2);
      assert(m === null, "VN does not re-fire when both already >= 8 before the send");
    } finally {
      await cleanupMatch(matchId);
    }
  }

  // 1d. FC fires when both reach 15
  {
    const matchId = await createTestMatch();
    try {
      await db.update(matches)
        .set({ messageCount1: 15, messageCount2: 14 } as any)
        .where(eq(matches.id, matchId));
      const pre = await getCounts(matchId);
      const { c1, c2 } = await atomicIncrement(matchId, false); // user2: 14→15
      const m = detectMilestone(pre.c1, pre.c2, c1, c2);
      assert(m === "first_call_unlocked", "FC fires when user2 reaches 15 (user1 already at 15)");
    } finally {
      await cleanupMatch(matchId);
    }
  }

  // 1e. FC self-healing: user1=16, user2=14 (race skipped 14→15 for user2)
  {
    const matchId = await createTestMatch();
    try {
      await db.update(matches)
        .set({ messageCount1: 16, messageCount2: 14 } as any)
        .where(eq(matches.id, matchId));
      const pre = await getCounts(matchId);
      const { c1, c2 } = await atomicIncrement(matchId, false); // user2: 14→15
      const m = detectMilestone(pre.c1, pre.c2, c1, c2);
      assert(m === "first_call_unlocked", "FC self-healing: fires when user2 crosses 15 even though user1 is at 16");
    } finally {
      await cleanupMatch(matchId);
    }
  }

  // 1f. System message (__ prefix) does not count
  {
    const isSystemPayload = (content: string) => content.trim().startsWith("__");
    assert(isSystemPayload("__VOICE__:abc"), "__ prefix detected as system message");
    assert(isSystemPayload("__SCHEDULE__:..."), "__ prefix detected for schedule payload");
    assert(!isSystemPayload("hello"), "Normal message not flagged as system");
    assert(!isSystemPayload("_only_one_underscore"), "Single leading _ not flagged as system (edge case)");
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 2 — Concurrency tests
// ─────────────────────────────────────────────────────────────────────────────

async function runConcurrencyTests() {
  console.log("\n── Concurrency tests ───────────────────────────────────────");

  // Fire N concurrent atomic increments on the same column — final count must equal N
  const N = 10;
  for (const isUser1 of [true, false]) {
    const col = isUser1 ? "user1" : "user2";
    const matchId = await createTestMatch();
    try {
      // Fire N increments concurrently
      await Promise.all(
        Array.from({ length: N }, () => atomicIncrement(matchId, isUser1))
      );
      const { c1, c2 } = await getCounts(matchId);
      const actual = isUser1 ? c1 : c2;
      assert(
        actual === N,
        `${N} concurrent ${col} increments → final count = ${N}`,
        actual !== N ? `got ${actual}` : undefined,
      );
    } finally {
      await cleanupMatch(matchId);
    }
  }

  // Mixed concurrency: 5 user1 + 5 user2 simultaneously — both columns must be exactly 5
  {
    const matchId = await createTestMatch();
    try {
      await Promise.all([
        ...Array.from({ length: 5 }, () => atomicIncrement(matchId, true)),
        ...Array.from({ length: 5 }, () => atomicIncrement(matchId, false)),
      ]);
      const { c1, c2 } = await getCounts(matchId);
      assert(c1 === 5 && c2 === 5, `5+5 mixed concurrent increments → c1=5, c2=5`, `got c1=${c1} c2=${c2}`);
    } finally {
      await cleanupMatch(matchId);
    }
  }

  // RETURNING gives authoritative post-increment value (not pre-increment)
  {
    const matchId = await createTestMatch();
    try {
      await db.update(matches).set({ messageCount1: 3 } as any).where(eq(matches.id, matchId));
      const { c1 } = await atomicIncrement(matchId, true);
      assert(c1 === 4, `RETURNING gives post-increment value (3→4)`, c1 !== 4 ? `got ${c1}` : undefined);
    } finally {
      await cleanupMatch(matchId);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST SUITE 3 — Reconciliation logic
// ─────────────────────────────────────────────────────────────────────────────

async function runReconciliationTests() {
  console.log("\n── Reconciliation tests ────────────────────────────────────");

  const VN_T = 8;
  const FC_T = 15;

  // Simulate reconciliation logic (mirrors the admin endpoint)
  async function reconcile(matchId: string): Promise<{
    before: { c1: number; c2: number };
    recount: { c1: number; c2: number };
    after: { c1: number; c2: number };
    vnEligible: boolean;
    fcEligible: boolean;
  }> {
    const before = await getCounts(matchId);

    // Count valid messages per sender (exclude __ prefix)
    const rows = await db
      .select({ senderId: messages.senderId, count: sqlExpr<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.matchId, matchId), sqlExpr`content !~ '^__'`))
      .groupBy(messages.senderId);

    const raw1 = rows.find(r => r.senderId === TEST_USER1)?.count ?? 0;
    const raw2 = rows.find(r => r.senderId === TEST_USER2)?.count ?? 0;
    const capped1 = Math.min(raw1, 15);
    const capped2 = Math.min(raw2, 15);

    const [repaired] = await db
      .update(matches)
      .set({ messageCount1: capped1, messageCount2: capped2 } as any)
      .where(eq(matches.id, matchId))
      .returning({ messageCount1: matches.messageCount1, messageCount2: matches.messageCount2 });

    const vnEligible = capped1 >= VN_T && capped2 >= VN_T;
    if (vnEligible) {
      await db.insert(voiceNoteUnlocks).values({ matchId }).onConflictDoNothing();
    }

    return {
      before,
      recount: { c1: raw1, c2: raw2 },
      after: { c1: repaired?.messageCount1 ?? capped1, c2: repaired?.messageCount2 ?? capped2 },
      vnEligible,
      fcEligible: capped1 >= FC_T && capped2 >= FC_T,
    };
  }

  async function insertMsg(matchId: string, senderId: string, content: string) {
    await db.insert(messages).values({
      matchId,
      senderId,
      content,
      createdAt: new Date(),
    } as any).catch(() => {});
  }

  // 3a. Corrupted count (counter skipped): recount fixes it
  {
    const matchId = await createTestMatch();
    try {
      // Set stored counts wrong (e.g. due to prior race)
      await db.update(matches).set({ messageCount1: 5, messageCount2: 5 } as any).where(eq(matches.id, matchId));

      // Insert 8 real messages per user
      for (let i = 0; i < 8; i++) {
        await insertMsg(matchId, TEST_USER1, `hello ${i}`);
        await insertMsg(matchId, TEST_USER2, `reply ${i}`);
      }

      const result = await reconcile(matchId);

      console.log(`    [RECONCILE] before=${JSON.stringify(result.before)} recount=${JSON.stringify(result.recount)} after=${JSON.stringify(result.after)}`);

      assert(result.after.c1 === 8, `Reconcile corrects user1 count from 5 to 8`, `got ${result.after.c1}`);
      assert(result.after.c2 === 8, `Reconcile corrects user2 count from 5 to 8`, `got ${result.after.c2}`);
      assert(result.vnEligible, "Reconcile detects VN eligible after recount (both >= 8)");

      // Check voiceNoteUnlocks row was inserted
      const [vnRow] = await db.select().from(voiceNoteUnlocks).where(eq(voiceNoteUnlocks.matchId, matchId));
      assert(!!vnRow, "Reconcile inserts voiceNoteUnlocks row when VN threshold met");
    } finally {
      await cleanupMatch(matchId);
    }
  }

  // 3b. System messages excluded from recount
  {
    const matchId = await createTestMatch();
    try {
      for (let i = 0; i < 6; i++) {
        await insertMsg(matchId, TEST_USER1, `msg ${i}`);
        await insertMsg(matchId, TEST_USER2, `msg ${i}`);
      }
      // Insert system messages that should NOT be counted
      await insertMsg(matchId, TEST_USER1, "__VOICE__:audio123");
      await insertMsg(matchId, TEST_USER2, "__SCHEDULE__:call");
      await insertMsg(matchId, TEST_USER1, "__SYS__:info");

      const result = await reconcile(matchId);
      assert(result.recount.c1 === 6, `Recount excludes __ system messages for user1 (6 real + 2 sys)`, `got ${result.recount.c1}`);
      assert(result.recount.c2 === 6, `Recount excludes __ system messages for user2 (6 real + 1 sys)`, `got ${result.recount.c2}`);
    } finally {
      await cleanupMatch(matchId);
    }
  }

  // 3c. Count capped at 15 — over-sending legacy match does not inflate beyond 15
  {
    const matchId = await createTestMatch();
    try {
      for (let i = 0; i < 20; i++) {
        await insertMsg(matchId, TEST_USER1, `msg ${i}`);
        await insertMsg(matchId, TEST_USER2, `msg ${i}`);
      }
      const result = await reconcile(matchId);
      assert(result.after.c1 === 15, `Reconcile caps count at 15 (20 messages stored)`, `got ${result.after.c1}`);
      assert(result.after.c2 === 15, `Reconcile caps count at 15 for user2`, `got ${result.after.c2}`);
      assert(result.fcEligible, "FC eligible after reconcile when both at 15");
    } finally {
      await cleanupMatch(matchId);
    }
  }

  // 3d. Idempotent: running reconcile twice gives same result
  {
    const matchId = await createTestMatch();
    try {
      for (let i = 0; i < 9; i++) {
        await insertMsg(matchId, TEST_USER1, `msg ${i}`);
        await insertMsg(matchId, TEST_USER2, `msg ${i}`);
      }
      const r1 = await reconcile(matchId);
      const r2 = await reconcile(matchId);
      assert(
        r1.after.c1 === r2.after.c1 && r1.after.c2 === r2.after.c2,
        `Reconcile is idempotent (run twice → same counts)`,
        `r1=${JSON.stringify(r1.after)} r2=${JSON.stringify(r2.after)}`,
      );
    } finally {
      await cleanupMatch(matchId);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log("Lulou Progression System Tests");
  console.log("================================");

  try {
    await runThresholdTests();
    await runConcurrencyTests();
    await runReconciliationTests();
  } finally {
    await pool.end();
  }

  console.log(`\n================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log("OVERALL: FAIL");
    process.exit(1);
  } else {
    console.log("OVERALL: PASS");
    process.exit(0);
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
