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

  it("hands an accepted call directly into the real active-call overlay", () => {
    const app = readFileSync("client/src/App.tsx", "utf8");
    const incoming = readFileSync("client/src/components/incoming-call.tsx", "utf8");
    const active = readFileSync("client/src/components/active-call.tsx", "utf8");
    const matches = readFileSync("client/src/pages/matches.tsx", "utf8");
    const routes = readFileSync("server/routes.ts", "utf8");
    const storage = readFileSync("server/storage.ts", "utf8");

    expect(incoming).toContain("const answeredMatch: MatchWithProfile");
    expect(incoming).toContain("callSessionId: match.callSessionId");
    expect(incoming).toContain("data?.callSessionId !== match.callSessionId");
    expect(incoming).toContain("isCallSessionCancelled(match.id, match.callSessionId)");
    expect(incoming).toContain('queryKey: ["/api/matches", match.id]');
    expect(incoming).toContain("onAnswer?.(answeredMatch)");
    expect(app).toContain("answeredCall || locallyAnsweredCall || callerRingingCall");
    expect(app).toContain("setLocallyAnsweredCall(answeredMatch)");
    expect(app).toContain("!== locallyAnsweredKey");
    expect(app).toContain("!isArmedSession(sessionId)");
    expect(app).toContain("isCallSessionCancelled(locallyAnsweredCall.id, sessionId)");
    expect(routes).toContain("callSessionId is required");
    expect(storage).toContain('.eq("call_session_id", expectedSessionId)');
    expect(storage).toContain('.not("call_started_at", "is", null)');
    expect(storage).toContain('.not("call_initiator_id", "is", null)');
    const answerConsumers = [incoming, matches];
    for (const consumer of answerConsumers) {
      expect(consumer).toContain("/call/answer");
      expect(consumer).toContain("callSessionId");
      expect(consumer).toContain("isCallSessionCancelled");
    }
    expect(active).toContain("const CALL_DURATIONS_SEC: Record<number, number> = { 0: 10 * 60");
    expect(active).toContain("useCountdownTimer(isConnected, stageDuration)");
    expect(active).toContain('data-testid="text-call-timer"');
    expect(active).toContain('data-testid="button-end-call"');
  });

  it("keeps the incoming answer interaction as a horizontal drag with decline available", () => {
    const incoming = readFileSync("client/src/components/incoming-call.tsx", "utf8");

    expect(incoming).toContain("SLIDE TO ANSWER");
    expect(incoming).toContain('thumb.addEventListener("pointerdown"');
    expect(incoming).toContain("sliderCurrentXRef.current >= maxDx * 0.8");
    expect(incoming).toContain('data-testid="button-answer-call"');
    expect(incoming).toContain('data-testid="button-decline-call"');
    expect(incoming).not.toContain('onKeyDown={(e) =>');
  });
});