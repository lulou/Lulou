import { CALL_STALE_RINGING_MS } from "../shared/call-lifecycle";

export interface CallRingingRow {
  id?: unknown;
  user1_id?: unknown;
  user2_id?: unknown;
  call_started_at?: unknown;
  call_initiator_id?: unknown;
  call_answered?: unknown;
  call_completed?: unknown;
  call_session_id?: unknown;
}

export type CallRingingFreshnessFailure =
  | "not_ringing"
  | "invalid_started_at"
  | "future_started_at"
  | "expired";

export function getCallRingingFreshnessFailure(
  callStartedAt: unknown,
  nowMs = Date.now(),
): CallRingingFreshnessFailure | null {
  if (callStartedAt === null || callStartedAt === undefined || callStartedAt === "") {
    return "not_ringing";
  }

  const startedAtMs = callStartedAt instanceof Date
    ? callStartedAt.getTime()
    : typeof callStartedAt === "string" || typeof callStartedAt === "number"
      ? new Date(callStartedAt).getTime()
      : Number.NaN;
  if (!Number.isFinite(startedAtMs)) return "invalid_started_at";
  if (!Number.isFinite(nowMs) || startedAtMs > nowMs) return "future_started_at";
  if (nowMs - startedAtMs > CALL_STALE_RINGING_MS) return "expired";
  return null;
}

export type IncomingCallAuthorityFailure =
  | "match_mismatch"
  | "not_participant"
  | "missing_caller"
  | "caller_not_participant"
  | "current_user_is_caller"
  | "callee_mismatch"
  | "missing_session_id"
  | "session_replaced"
  | "already_answered"
  | "already_completed"
  | "invalid_call_flags"
  | CallRingingFreshnessFailure;

export function getIncomingCallAuthorityFailure(
  row: CallRingingRow,
  options: {
    matchId: string;
    userId: string;
    callSessionId: string;
    nowMs?: number;
  },
): IncomingCallAuthorityFailure | null {
  const { matchId, userId, callSessionId, nowMs } = options;
  if (row.id !== matchId) return "match_mismatch";

  const isUser1 = row.user1_id === userId;
  const isUser2 = row.user2_id === userId;
  if (!isUser1 && !isUser2) return "not_participant";

  const callerId = row.call_initiator_id;
  if (typeof callerId !== "string" || !callerId) return "missing_caller";
  const callerIsUser1 = callerId === row.user1_id;
  const callerIsUser2 = callerId === row.user2_id;
  if (!callerIsUser1 && !callerIsUser2) return "caller_not_participant";
  if (callerId === userId) return "current_user_is_caller";

  const calleeId = callerIsUser1 ? row.user2_id : row.user1_id;
  if (calleeId !== userId) return "callee_mismatch";

  if (typeof row.call_session_id !== "string" || !row.call_session_id.trim()) {
    return "missing_session_id";
  }
  if (typeof callSessionId !== "string" || !callSessionId.trim()) return "missing_session_id";
  if (row.call_session_id !== callSessionId) return "session_replaced";

  if (row.call_answered === true) return "already_answered";
  if (row.call_completed === true) return "already_completed";
  if (row.call_answered !== false || row.call_completed !== false) {
    return "invalid_call_flags";
  }

  return getCallRingingFreshnessFailure(row.call_started_at, nowMs);
}

export type ReringCallValidation =
  | { valid: true; callSessionId: string }
  | { valid: false; reason: string };

export function validateReringCall(
  row: CallRingingRow,
  options: {
    matchId: string;
    userId: string;
    expectedSessionId?: unknown;
    expectedSessionIdProvided: boolean;
    nowMs?: number;
  },
): ReringCallValidation {
  const {
    matchId,
    userId,
    expectedSessionId,
    expectedSessionIdProvided,
    nowMs,
  } = options;

  if (row.id !== matchId) return { valid: false, reason: "match_mismatch" };

  const isParticipant = row.user1_id === userId || row.user2_id === userId;
  if (!isParticipant) return { valid: false, reason: "not_participant" };
  if (typeof row.call_initiator_id !== "string" || !row.call_initiator_id) {
    return { valid: false, reason: "missing_caller" };
  }
  if (row.call_initiator_id !== row.user1_id && row.call_initiator_id !== row.user2_id) {
    return { valid: false, reason: "caller_not_participant" };
  }
  if (row.call_initiator_id !== userId) return { valid: false, reason: "not_initiator" };

  if (typeof row.call_session_id !== "string" || !row.call_session_id.trim()) {
    return { valid: false, reason: "missing_session_id" };
  }
  if (
    expectedSessionIdProvided
    && (typeof expectedSessionId !== "string" || expectedSessionId !== row.call_session_id)
  ) {
    return { valid: false, reason: "session_mismatch" };
  }

  if (row.call_answered === true) return { valid: false, reason: "already_answered" };
  if (row.call_completed === true) return { valid: false, reason: "already_completed" };
  if (row.call_answered !== false || row.call_completed !== false) {
    return { valid: false, reason: "invalid_call_flags" };
  }

  const freshnessFailure = getCallRingingFreshnessFailure(row.call_started_at, nowMs);
  if (freshnessFailure) return { valid: false, reason: freshnessFailure };

  return { valid: true, callSessionId: row.call_session_id };
}