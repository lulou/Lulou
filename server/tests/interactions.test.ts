/**
 * Regression tests for the Like Back / interaction-upgrade flow.
 *
 * These tests isolate the route-handler logic from the database by using a
 * lightweight in-memory mock that implements the subset of IStorage needed by
 * POST /api/interactions.  They do NOT hit the network or Supabase.
 *
 * Run:  npx vitest run --config vitest.config.ts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ─── Minimal type stubs ──────────────────────────────────────────────────────

interface Interaction {
  id: string;
  fromUserId: string;
  toUserId: string;
  type: string;
  createdAt: Date;
}

interface Match {
  id: string;
  user1Id: string;
  user2Id: string;
  status: string;
}

// ─── In-memory mock storage ──────────────────────────────────────────────────

class MockStorage {
  private interactions: Map<string, Interaction> = new Map();
  private matches: Map<string, Match> = new Map();
  private _nextId = 1;

  private key(from: string, to: string) { return `${from}→${to}`; }

  async createInteraction(data: { fromUserId: string; toUserId: string; type: string }): Promise<Interaction> {
    const k = this.key(data.fromUserId, data.toUserId);
    if (this.interactions.has(k)) throw new Error("Unique constraint violation");
    const row: Interaction = { id: String(this._nextId++), fromUserId: data.fromUserId, toUserId: data.toUserId, type: data.type, createdAt: new Date() };
    this.interactions.set(k, row);
    return row;
  }

  async updateInteractionType(id: string, newType: string): Promise<void> {
    for (const [k, row] of this.interactions.entries()) {
      if (row.id === id) { this.interactions.set(k, { ...row, type: newType }); return; }
    }
    throw new Error(`Interaction ${id} not found`);
  }

  async getInteraction(from: string, to: string): Promise<Interaction | undefined> {
    return this.interactions.get(this.key(from, to));
  }

  async getMatchCount(userId: string): Promise<number> {
    return [...this.matches.values()].filter(m => m.status === "active" && (m.user1Id === userId || m.user2Id === userId)).length;
  }

  async createMatch(u1: string, u2: string): Promise<Match> {
    const id = String(this._nextId++);
    const match: Match = { id, user1Id: u1, user2Id: u2, status: "active" };
    this.matches.set(id, match);
    return match;
  }

  async findMatchBetweenUsers(u1: string, u2: string): Promise<Match | undefined> {
    return [...this.matches.values()].find(m =>
      (m.user1Id === u1 && m.user2Id === u2) || (m.user1Id === u2 && m.user2Id === u1)
    );
  }

  // Snapshot helpers
  interactionCount() { return this.interactions.size; }
  matchCount() { return this.matches.size; }
  getStoredInteraction(from: string, to: string) { return this.interactions.get(this.key(from, to)); }
}

// ─── Extracted route-handler logic ───────────────────────────────────────────
// Mirrors the exact decision tree in POST /api/interactions so we can unit-test
// it without spinning up Express.

type RouteResult =
  | { status: 200; body: { interaction: Interaction | null; matched: boolean; matchId?: string; connectionLimitReached?: boolean } }
  | { status: 400; body: { message: string } };

async function handleInteraction(
  storage: MockStorage,
  fromUserId: string,
  toUserId: string,
  type: "open" | "close",
): Promise<RouteResult> {
  if (fromUserId === toUserId) {
    return { status: 400, body: { message: "Cannot interact with yourself" } };
  }

  const existing = await storage.getInteraction(fromUserId, toUserId);
  let interaction: Interaction;

  if (existing) {
    if (type === "open") {
      if (existing.type === "close") {
        // Upgrade close → open (Like Back after a Discover pass)
        await storage.updateInteractionType(existing.id, "open");
        interaction = { ...existing, type: "open" };
      } else if (existing.type === "open") {
        // Idempotent — fall through to match detection
        interaction = existing;
      } else {
        return { status: 400, body: { message: "Already interacted" } };
      }
    } else {
      // type === "close": idempotent regardless of existing type
      return { status: 200, body: { interaction: existing, matched: false } };
    }
  } else {
    if (type === "open") {
      const matchCount = await storage.getMatchCount(fromUserId);
      if (matchCount >= 8) {
        return { status: 200, body: { matched: false, connectionLimitReached: true, interaction: null } };
      }
    }
    interaction = await storage.createInteraction({ fromUserId, toUserId, type });
  }

  // Connection-limit check for the close→open upgrade path
  if (type === "open" && existing) {
    const matchCount = await storage.getMatchCount(fromUserId);
    if (matchCount >= 8) {
      return { status: 200, body: { matched: false, connectionLimitReached: true, interaction } };
    }
  }

  let matched = false;
  let matchId: string | undefined;

  if (type === "open") {
    const reverseOpen = await storage.getInteraction(toUserId, fromUserId);
    if (reverseOpen && reverseOpen.type === "open") {
      // Guard against duplicate matches: idempotent double-tap returns the
      // existing match rather than creating a second one.
      const alreadyMatched = await storage.findMatchBetweenUsers(fromUserId, toUserId);
      if (alreadyMatched) {
        matched = true;
        matchId = alreadyMatched.id;
      } else {
        const fromCount = await storage.getMatchCount(fromUserId);
        const toCount   = await storage.getMatchCount(toUserId);
        if (fromCount < 8 && toCount < 8) {
          const newMatch = await storage.createMatch(fromUserId, toUserId);
          matched = true;
          matchId = newMatch.id;
        }
      }
    }
  }

  return { status: 200, body: { interaction, matched, matchId } };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

const A = "user-A";
const B = "user-B";
const C = "user-C";

describe("POST /api/interactions — Like Back regression", () => {
  let storage: MockStorage;

  beforeEach(() => { storage = new MockStorage(); });

  // ── Core Like Back scenarios ─────────────────────────────────────────────

  it("close → Like Back: B passed A in Discover, A likes B, B likes back → match", async () => {
    await storage.createInteraction({ fromUserId: B, toUserId: A, type: "close" });
    await handleInteraction(storage, A, B, "open"); // A likes B (no existing row)

    const result = await handleInteraction(storage, B, A, "open"); // B likes back

    expect(result.status).toBe(200);
    expect(result.body.matched).toBe(true);
    expect(result.body.matchId).toBeDefined();
    // Interaction B→A must now be type=open (upgraded from close)
    expect(storage.getStoredInteraction(B, A)?.type).toBe("open");
    // Exactly one match
    expect(storage.matchCount()).toBe(1);
  });

  it("close → Like Back: B→A row is upgraded in-place, no extra interaction row", async () => {
    await storage.createInteraction({ fromUserId: B, toUserId: A, type: "close" });
    await storage.createInteraction({ fromUserId: A, toUserId: B, type: "open" });
    const countBefore = storage.interactionCount();

    await handleInteraction(storage, B, A, "open");

    expect(storage.getStoredInteraction(B, A)?.type).toBe("open");
    expect(storage.interactionCount()).toBe(countBefore); // upgrade, not INSERT
  });

  it("close → Like Back returns 200, not 400 'Already interacted'", async () => {
    await storage.createInteraction({ fromUserId: B, toUserId: A, type: "close" });

    const result = await handleInteraction(storage, B, A, "open");

    expect(result.status).toBe(200);
    expect((result.body as any).message).toBeUndefined();
  });

  it("open → Like Back (idempotent): second Like Back doesn't create a second match", async () => {
    await storage.createInteraction({ fromUserId: B, toUserId: A, type: "open" });
    await storage.createInteraction({ fromUserId: A, toUserId: B, type: "open" });

    const r1 = await handleInteraction(storage, B, A, "open"); // creates match
    const r2 = await handleInteraction(storage, B, A, "open"); // idempotent

    expect(r1.body.matched).toBe(true);
    expect(r2.body.matched).toBe(true);
    expect(r1.body.matchId).toBe(r2.body.matchId); // same match returned both times
    expect(storage.matchCount()).toBe(1);
    expect(storage.interactionCount()).toBe(2); // no new rows
  });

  it("duplicate Like Back request: same open→open twice creates exactly one match", async () => {
    await storage.createInteraction({ fromUserId: A, toUserId: B, type: "open" });

    const r1 = await handleInteraction(storage, B, A, "open");
    const r2 = await handleInteraction(storage, B, A, "open"); // double-tap

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(storage.matchCount()).toBe(1); // only one match ever
    expect(storage.interactionCount()).toBe(2); // A→B and B→A only
  });

  // ── Match-integrity guarantees ────────────────────────────────────────────

  it("mutual opens (fresh rows) create exactly one match", async () => {
    const r1 = await handleInteraction(storage, A, B, "open");
    const r2 = await handleInteraction(storage, B, A, "open");

    expect(r1.body.matched).toBe(false); // B hasn't liked A yet
    expect(r2.body.matched).toBe(true);  // mutual → match
    expect(storage.matchCount()).toBe(1);
  });

  it("mutual open creates one match only — pre-seeded rows, idempotent second call", async () => {
    await storage.createInteraction({ fromUserId: A, toUserId: B, type: "open" });
    await storage.createInteraction({ fromUserId: B, toUserId: A, type: "open" });

    const createMatchSpy = vi.spyOn(storage, "createMatch");

    // First call: both opens exist, no match yet → creates match
    await handleInteraction(storage, A, B, "open");
    expect(storage.matchCount()).toBe(1);
    expect(createMatchSpy).toHaveBeenCalledTimes(1);

    // Second call: match already exists → idempotent, no second createMatch
    await handleInteraction(storage, A, B, "open");
    expect(storage.matchCount()).toBe(1);
    expect(createMatchSpy).toHaveBeenCalledTimes(1); // still 1
  });

  it("no duplicate interaction rows: close→open upgrade does not INSERT a second row", async () => {
    await storage.createInteraction({ fromUserId: B, toUserId: A, type: "close" });
    const countBefore = storage.interactionCount();

    await handleInteraction(storage, B, A, "open");

    expect(storage.interactionCount()).toBe(countBefore);
  });

  it("no duplicate matches: concurrent-style double mutual open", async () => {
    await handleInteraction(storage, A, B, "open");
    await handleInteraction(storage, B, A, "open"); // creates match
    await handleInteraction(storage, A, B, "open"); // idempotent — no second match
    await handleInteraction(storage, B, A, "open"); // idempotent — no second match

    expect(storage.matchCount()).toBe(1);
  });

  // ── Pass / close scenarios (unrelated behaviour unchanged) ───────────────

  it("re-passing (type=close) when already closed is idempotent — 200, no error", async () => {
    await storage.createInteraction({ fromUserId: B, toUserId: A, type: "close" });

    const result = await handleInteraction(storage, B, A, "close");

    expect(result.status).toBe(200);
    expect(result.body.matched).toBe(false);
    expect(storage.interactionCount()).toBe(1); // no new row
  });

  it("passing after a like (open→close) is idempotent — does not error", async () => {
    await storage.createInteraction({ fromUserId: B, toUserId: A, type: "open" });

    const result = await handleInteraction(storage, B, A, "close");

    expect(result.status).toBe(200);
    expect(result.body.matched).toBe(false);
  });

  it("A passes B in Discover (close), then B likes A — no match created yet", async () => {
    await handleInteraction(storage, A, B, "close"); // A passes B

    const result = await handleInteraction(storage, B, A, "open"); // B likes A

    expect(result.status).toBe(200);
    expect(result.body.matched).toBe(false); // A→B is close, not open
    expect(storage.matchCount()).toBe(0);
  });

  // ── Self-interaction guard ────────────────────────────────────────────────

  it("self-like is rejected with 400", async () => {
    const result = await handleInteraction(storage, A, A, "open");
    expect(result.status).toBe(400);
  });

  // ── Unrelated user isolation ──────────────────────────────────────────────

  it("A↔B interactions do not affect A↔C", async () => {
    await handleInteraction(storage, A, B, "open");
    await handleInteraction(storage, B, A, "open"); // A↔B matched

    const beforeCount = storage.matchCount();

    await handleInteraction(storage, C, A, "open");
    const result = await handleInteraction(storage, A, C, "open");

    expect(result.body.matched).toBe(true);
    expect(storage.matchCount()).toBe(beforeCount + 1);
  });

  it("A→B like does not appear in B→A interaction lookup", async () => {
    await handleInteraction(storage, A, B, "open");
    expect(await storage.getInteraction(B, A)).toBeUndefined();
  });

  // ── Connection limit ──────────────────────────────────────────────────────

  it("connectionLimitReached is returned (not an error) when B already has 8 matches", async () => {
    for (let i = 0; i < 8; i++) {
      await storage.createMatch(B, `limit-user-${i}`);
    }
    await storage.createInteraction({ fromUserId: A, toUserId: B, type: "open" });

    const result = await handleInteraction(storage, B, A, "open");

    expect(result.status).toBe(200);
    expect((result.body as any).connectionLimitReached).toBe(true);
    expect(result.body.matched).toBe(false);
    expect(storage.matchCount()).toBe(8); // no new match
  });
});
