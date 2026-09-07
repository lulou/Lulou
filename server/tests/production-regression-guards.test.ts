import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("production regression guards", () => {
  it("applies production-account exclusions to every Discover and Wheel query tier", () => {
    const storage = readFileSync("server/storage.ts", "utf8");

    expect(storage).toContain('const LEGACY_SEED_USER_ID_LIKE = "10000000-0000-4000-a000-0000000000%"');
    expect(storage.split("applyProductionCandidateGuards(this.sb").length - 1).toBeGreaterThanOrEqual(5);
    expect(storage).toContain('.not("user_id", "like", LEGACY_SEED_USER_ID_LIKE)');
    expect(storage).toContain('guarded = guarded.or("is_paused.is.null,is_paused.eq.false")');
    expect(storage).toContain('guarded = guarded.eq("is_discoverable", true)');
    expect(storage).toContain('guarded = guarded.eq("email_verified", true)');
  });

  it("keeps incoming-call startup restoration behind backend and session guards", () => {
    const app = readFileSync("client/src/App.tsx", "utf8");
    const signaling = readFileSync("client/src/hooks/use-call-signaling.ts", "utf8");
    const audio = readFileSync("client/src/lib/call-audio.ts", "utf8");

    expect(app).toContain("clearAllArmedSessions()");
    expect(app).toContain('stopAllCallSounds("calldetectors_mount")');
    expect(app).toContain("startupVerified &&");
    expect(app).toContain("isArmedSession(m.callSessionId)");
    expect(app).toContain("!isCallSessionCancelled(m.id, m.callSessionId)");
    expect(app).toContain("!isEndedCall(m)");
    expect(app).toContain("!isStaleCall(m)");
    expect(signaling).toContain("isStartupSweepComplete()");
    expect(audio).toContain("isStartupSweepComplete");
  });
});