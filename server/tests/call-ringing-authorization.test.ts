import { describe, expect, it } from "vitest";
import {
  getCallRingingFreshnessFailure,
  getIncomingCallAuthorityFailure,
  validateReringCall,
  type CallRingingRow,
} from "../call-ringing-authorization";

const nowMs = 1_800_000_000_000;
const liveIncomingCall: CallRingingRow = {
  id: "match-1",
  user1_id: "caller-1",
  user2_id: "callee-1",
  call_started_at: new Date(nowMs - 30_000).toISOString(),
  call_initiator_id: "caller-1",
  call_answered: false,
  call_completed: false,
  call_session_id: "call-match-1-session-1",
};

describe("incoming-call backend authorization", () => {
  it("accepts only a fresh, exact-session call from a match member to the other member", () => {
    expect(getIncomingCallAuthorityFailure(liveIncomingCall, {
      matchId: "match-1",
      userId: "callee-1",
      callSessionId: "call-match-1-session-1",
      nowMs,
    })).toBeNull();
  });

  it("rejects callers outside the matched pair even when the current user is a participant", () => {
    expect(getIncomingCallAuthorityFailure({
      ...liveIncomingCall,
      call_initiator_id: "unrelated-user",
    }, {
      matchId: "match-1",
      userId: "caller-1",
      callSessionId: "call-match-1-session-1",
      nowMs,
    })).toBe("caller_not_participant");
  });

  it("rejects a current user who is not the addressed callee", () => {
    expect(getIncomingCallAuthorityFailure(liveIncomingCall, {
      matchId: "match-1",
      userId: "caller-1",
      callSessionId: "call-match-1-session-1",
      nowMs,
    })).toBe("current_user_is_caller");

    expect(getIncomingCallAuthorityFailure(liveIncomingCall, {
      matchId: "match-1",
      userId: "outsider",
      callSessionId: "call-match-1-session-1",
      nowMs,
    })).toBe("not_participant");
  });

  it("rejects a mismatched match, replaced or missing session, and answered or ended calls", () => {
    const verify = (row: CallRingingRow, matchId = "match-1") => getIncomingCallAuthorityFailure(row, {
      matchId,
      userId: "callee-1",
      callSessionId: "call-match-1-session-1",
      nowMs,
    });

    expect(verify(liveIncomingCall, "another-match")).toBe("match_mismatch");
    expect(verify({ ...liveIncomingCall, call_session_id: "new-session" })).toBe("session_replaced");
    expect(verify({ ...liveIncomingCall, call_session_id: null })).toBe("missing_session_id");
    expect(getIncomingCallAuthorityFailure(liveIncomingCall, {
      matchId: "match-1",
      userId: "callee-1",
      callSessionId: " ",
      nowMs,
    })).toBe("missing_session_id");
    expect(verify({ ...liveIncomingCall, call_answered: true })).toBe("already_answered");
    expect(verify({ ...liveIncomingCall, call_completed: true })).toBe("already_completed");
    expect(verify({ ...liveIncomingCall, call_answered: null })).toBe("invalid_call_flags");
  });

  it("rejects invalid, future-dated, and older-than-90-second incoming sessions", () => {
    expect(getCallRingingFreshnessFailure("not-a-date", nowMs)).toBe("invalid_started_at");
    expect(getCallRingingFreshnessFailure(new Date(nowMs + 1).toISOString(), nowMs)).toBe("future_started_at");
    expect(getCallRingingFreshnessFailure(new Date(nowMs - 90_001).toISOString(), nowMs)).toBe("expired");

    for (const call_started_at of [
      "not-a-date",
      new Date(nowMs + 1).toISOString(),
      new Date(nowMs - 90_001).toISOString(),
    ]) {
      expect(getIncomingCallAuthorityFailure({ ...liveIncomingCall, call_started_at }, {
        matchId: "match-1",
        userId: "callee-1",
        callSessionId: "call-match-1-session-1",
        nowMs,
      })).not.toBeNull();
    }
  });
});

describe("call/rering backend authorization", () => {
  const validate = (
    row: CallRingingRow,
    expectedSessionId?: unknown,
    expectedSessionIdProvided = true,
  ) => validateReringCall(row, {
    matchId: "match-1",
    userId: "caller-1",
    expectedSessionId,
    expectedSessionIdProvided,
    nowMs,
  });

  it("derives the persisted exact session only when the legacy caller omitted a session ID", () => {
    expect(validate(liveIncomingCall, undefined, false)).toEqual({
      valid: true,
      callSessionId: "call-match-1-session-1",
    });
    expect(validate(liveIncomingCall, "call-match-1-session-1")).toEqual({
      valid: true,
      callSessionId: "call-match-1-session-1",
    });
  });

  it("rejects a supplied wrong or empty session ID and a missing persisted session", () => {
    expect(validate(liveIncomingCall, "another-session")).toEqual({
      valid: false,
      reason: "session_mismatch",
    });
    expect(validate(liveIncomingCall, null)).toEqual({
      valid: false,
      reason: "session_mismatch",
    });
    expect(validate({ ...liveIncomingCall, call_session_id: null }, undefined, false)).toEqual({
      valid: false,
      reason: "missing_session_id",
    });
    expect(validate({ ...liveIncomingCall, call_session_id: " " }, undefined, false)).toEqual({
      valid: false,
      reason: "missing_session_id",
    });
  });

  it("requires the authenticated caller, exact match, live ringing flags, and a fresh valid timestamp", () => {
    expect(validate({ ...liveIncomingCall, id: "another-match" }, undefined, false)).toEqual({
      valid: false,
      reason: "match_mismatch",
    });
    expect(validate({ ...liveIncomingCall, call_initiator_id: "callee-1" }, undefined, false)).toEqual({
      valid: false,
      reason: "not_initiator",
    });
    expect(validate({ ...liveIncomingCall, call_initiator_id: "outsider" }, undefined, false)).toEqual({
      valid: false,
      reason: "caller_not_participant",
    });
    expect(validate({ ...liveIncomingCall, call_answered: true }, undefined, false)).toEqual({
      valid: false,
      reason: "already_answered",
    });
    expect(validate({ ...liveIncomingCall, call_completed: true }, undefined, false)).toEqual({
      valid: false,
      reason: "already_completed",
    });
    expect(validate({ ...liveIncomingCall, call_started_at: new Date(nowMs + 1).toISOString() }, undefined, false)).toEqual({
      valid: false,
      reason: "future_started_at",
    });
    expect(validate({ ...liveIncomingCall, call_started_at: new Date(nowMs - 90_001).toISOString() }, undefined, false)).toEqual({
      valid: false,
      reason: "expired",
    });
  });
});