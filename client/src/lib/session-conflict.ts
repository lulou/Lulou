export type SessionReplacementSource = "api" | "query" | "heartbeat" | "realtime";

export type SessionReplacedEventDetail = {
  reason: "session_replaced";
  sessionId: string;
  source: SessionReplacementSource;
};

export type ForcedLogoutNotice = {
  reason: "session_replaced";
  invalidatedUserId: string;
  invalidatedSessionId: string;
};

export function isCurrentSessionReplacement(
  detail: unknown,
  currentUserId: string | null | undefined,
  currentSessionId: string,
): detail is SessionReplacedEventDetail {
  if (!detail || typeof detail !== "object") return false;
  const candidate = detail as Partial<SessionReplacedEventDetail>;
  return (
    candidate.reason === "session_replaced" &&
    typeof candidate.sessionId === "string" &&
    candidate.sessionId.length > 0 &&
    !!currentUserId &&
    candidate.sessionId === currentSessionId
  );
}