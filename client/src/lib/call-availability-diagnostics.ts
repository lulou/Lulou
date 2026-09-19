import { API_BASE } from "@/lib/queryClient";

export type CallAvailabilityDiagnosticEvent =
  | "availability_clicked"
  | "availability_api_sent"
  | "availability_api_response"
  | "availability_event_received"
  | "availability_ui_updated"
  | "start_call_clicked"
  | "start_call_api_sent"
  | "start_call_api_response"
  | "incoming_event_received"
  | "incoming_guard_decision"
  | "incoming_cache_updated"
  | "incoming_ui_mounted"
  | "caller_ringing_state"
  | "call_ui_painted"
  | "answer_slide_completed"
  | "answer_api_sent"
  | "answer_api_response"
  | "answer_state_applied"
  | "active_call_mounted";

type CallAvailabilityDiagnostic = {
  event: CallAvailabilityDiagnosticEvent;
  diagId: string;
  role: "sender" | "receiver";
  clientAt: number;
  elapsedMs?: number | null;
  httpStatus?: number | null;
  outcome?: "started" | "success" | "error" | "applied" | "stale";
  availabilityVersion?: number | null;
  callStage?: number | null;
  sessionPresent?: boolean;
  attempt?: number;
  guardReason?:
    | "stale_null_cache"
    | "stale_cached_start"
    | "startup_cancelled"
    | "presweep_deferred"
    | "presweep_stale"
    | "prelogin_stale"
    | "session_cancelled"
    | "armed"
    | "list_patched"
    | "list_cache_missing"
    | "list_session_mismatch"
    | "overlay_mounted";
  cacheApplied?: boolean;
  overlayAttached?: boolean;
  overlayViewportSized?: boolean;
  overlayCenterOwned?: boolean;
  overlayVisible?: boolean;
  errorCategory?: "auth" | "eligibility" | "conflict" | "network" | "unknown";
};

const startCallCorrelations = new Map<string, {
  diagId: string;
  clickedAt: number;
  callStage: number;
  ringingReported: boolean;
  paintReported: boolean;
}>();

const incomingCallCorrelations = new Map<string, {
  diagId: string;
  receivedAt: number;
  attempt: number;
  mountedReported: boolean;
  paintReported: boolean;
}>();

export function createCallAvailabilityDiagId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export function reportCallAvailabilityDiagnostic(payload: CallAvailabilityDiagnostic): void {
  try {
    void fetch(`${API_BASE}/api/diagnostics/call-availability`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Diagnostics must never affect availability behavior.
  }
}

export function registerStartCallDiagnostic(
  callSessionId: string,
  diagId: string,
  clickedAt: number,
  callStage: number,
): void {
  startCallCorrelations.set(callSessionId, {
    diagId,
    clickedAt,
    callStage,
    ringingReported: false,
    paintReported: false,
  });
}

export function reportCallerRingingState(callSessionId: string): void {
  const correlation = startCallCorrelations.get(callSessionId);
  if (!correlation || correlation.ringingReported) return;
  correlation.ringingReported = true;
  reportCallAvailabilityDiagnostic({
    event: "caller_ringing_state",
    diagId: correlation.diagId,
    role: "sender",
    clientAt: Date.now(),
    elapsedMs: Date.now() - correlation.clickedAt,
    outcome: "applied",
    callStage: correlation.callStage,
    sessionPresent: true,
  });
}

export function registerIncomingCallDiagnostic(
  callSessionId: string,
  diagId: string,
  receivedAt: number,
  attempt: number,
): void {
  incomingCallCorrelations.set(callSessionId, {
    diagId,
    receivedAt,
    attempt,
    mountedReported: false,
    paintReported: false,
  });
}

export function reportIncomingCallMounted(callSessionId: string): void {
  const correlation = incomingCallCorrelations.get(callSessionId);
  if (!correlation || correlation.mountedReported) return;
  correlation.mountedReported = true;
  reportCallAvailabilityDiagnostic({
    event: "incoming_ui_mounted",
    diagId: correlation.diagId,
    role: "receiver",
    clientAt: Date.now(),
    elapsedMs: Date.now() - correlation.receivedAt,
    outcome: "applied",
    attempt: correlation.attempt,
    sessionPresent: true,
    guardReason: "overlay_mounted",
  });
}

type CallUiPaintFacts = {
  attached: boolean;
  viewportSized: boolean;
  centerOwned: boolean;
  visible: boolean;
};

export function reportCallUiPaint(
  callSessionId: string,
  role: "sender" | "receiver",
  facts: CallUiPaintFacts,
): void {
  const correlation = role === "sender"
    ? startCallCorrelations.get(callSessionId)
    : incomingCallCorrelations.get(callSessionId);
  if (!correlation || correlation.paintReported) return;
  correlation.paintReported = true;
  const startedAt = role === "sender"
    ? (correlation as { clickedAt: number }).clickedAt
    : (correlation as { receivedAt: number }).receivedAt;
  reportCallAvailabilityDiagnostic({
    event: "call_ui_painted",
    diagId: correlation.diagId,
    role,
    clientAt: Date.now(),
    elapsedMs: Date.now() - startedAt,
    outcome: facts.attached && facts.viewportSized && facts.centerOwned && facts.visible
      ? "applied"
      : "error",
    sessionPresent: true,
    overlayAttached: facts.attached,
    overlayViewportSized: facts.viewportSized,
    overlayCenterOwned: facts.centerOwned,
    overlayVisible: facts.visible,
  });
}

export function getIncomingCallDiagnosticId(callSessionId: string | null | undefined): string | null {
  if (!callSessionId) return null;
  return incomingCallCorrelations.get(callSessionId)?.diagId ?? null;
}

export function reportAnswerDiagnostic(
  callSessionId: string | null | undefined,
  event:
    | "answer_slide_completed"
    | "answer_api_sent"
    | "answer_api_response"
    | "answer_state_applied"
    | "active_call_mounted",
  details: Pick<CallAvailabilityDiagnostic, "httpStatus" | "outcome"> = {},
): void {
  if (!callSessionId) return;
  const correlation = incomingCallCorrelations.get(callSessionId);
  if (!correlation) return;
  reportCallAvailabilityDiagnostic({
    event,
    diagId: correlation.diagId,
    role: "receiver",
    clientAt: Date.now(),
    elapsedMs: Date.now() - correlation.receivedAt,
    sessionPresent: true,
    attempt: correlation.attempt,
    ...details,
  });
}