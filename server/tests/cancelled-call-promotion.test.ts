import { describe, expect, it } from "vitest";
import {
  clearStartupCancelledSession,
  isCallSessionCancelled,
  isStartupCancelledOnly,
  markCallSessionCancelled,
  markStartupCancelledSession,
} from "../../client/src/lib/cancelled-calls";

describe("cancelled call promotion", () => {
  it("keeps a terminal cancellation permanent when verification finishes late", () => {
    const matchId = "match-terminal-during-verification";
    const sessionId = "session-terminal-during-verification";

    markStartupCancelledSession(matchId, sessionId);
    expect(isStartupCancelledOnly(matchId, sessionId)).toBe(true);

    // Terminal event arrives while exact server verification is awaiting.
    markCallSessionCancelled(matchId, sessionId);
    expect(isStartupCancelledOnly(matchId, sessionId)).toBe(false);

    // A late verification result must not be able to lift the terminal block.
    clearStartupCancelledSession(matchId, sessionId);
    expect(isCallSessionCancelled(matchId, sessionId)).toBe(true);
  });
});