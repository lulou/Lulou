import { API_BASE } from "@/lib/queryClient";

export type CallAvailabilityDiagnosticEvent =
  | "availability_clicked"
  | "availability_api_sent"
  | "availability_api_response"
  | "availability_event_received"
  | "availability_ui_updated";

type CallAvailabilityDiagnostic = {
  event: CallAvailabilityDiagnosticEvent;
  diagId: string;
  role: "sender" | "receiver";
  clientAt: number;
  elapsedMs?: number | null;
  httpStatus?: number | null;
  outcome?: "started" | "success" | "error" | "applied" | "stale";
  availabilityVersion?: number | null;
};

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