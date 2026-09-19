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
  | "caller_ringing_state";

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
  errorCategory?: "auth" | "eligibility" | "conflict" | "network" | "unknown";
};

const startCallCorrelations = new Map<string, {
  diagId: string;
  clickedAt: number;
  callStage: number;
  ringingReported: boolean;
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