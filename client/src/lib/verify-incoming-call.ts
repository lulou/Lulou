import { apiRequest } from "@/lib/queryClient";
import type { IncomingCallCandidate, IncomingCallVerification } from "./incoming-call-authority";

/** Existing backend contract; no transport or production configuration change. */
export async function verifyIncomingCall(candidate: IncomingCallCandidate): Promise<IncomingCallVerification | null> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await apiRequest("POST", `/api/matches/${encodeURIComponent(candidate.matchId)}/call/verify-incoming`,
      { callSessionId: candidate.callSessionId }, { signal: controller.signal });
    return await response.json();
  } catch {
    return null;
  } finally {
    window.clearTimeout(timeout);
  }
}