import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { getAuthHeaders, API_BASE } from "@/lib/queryClient";
import { RefreshCw, ShieldCheck, ShieldOff, Mail, AlertCircle, CheckCircle, Clock, ArrowLeft } from "lucide-react";
import { useLocation } from "wouter";

interface EmailEvent {
  ts: string;
  type: string;
  userId?: string;
  email?: string;
  note?: string;
  success: boolean;
}

interface DiagnosticsData {
  summary: {
    total: number;
    sent: number;
    failed: number;
    rateLimited: number;
    verified: number;
    blocked: number;
  };
  events: EmailEvent[];
  serverUptime: number;
  enforcementDate: string;
}

const EVENT_COLORS: Record<string, string> = {
  signup_otp_sent:        "bg-blue-50 text-blue-700 border-blue-200",
  signup_otp_rate_limited:"bg-amber-50 text-amber-700 border-amber-200",
  signup_otp_send_failed: "bg-red-50 text-red-700 border-red-200",
  otp_verified:           "bg-green-50 text-green-700 border-green-200",
  otp_verify_failed:      "bg-red-50 text-red-700 border-red-200",
  resend_queued:          "bg-blue-50 text-blue-700 border-blue-200",
  resend_rate_limited:    "bg-amber-50 text-amber-700 border-amber-200",
  resend_failed:          "bg-red-50 text-red-700 border-red-200",
  verified:               "bg-green-50 text-green-700 border-green-200",
  blocked_unconfirmed:    "bg-red-50 text-red-700 border-red-200",
  blocked_auto_confirmed: "bg-orange-50 text-orange-700 border-orange-200",
  pwd_reset_sent:         "bg-purple-50 text-purple-700 border-purple-200",
  pwd_reset_failed:       "bg-red-50 text-red-700 border-red-200",
};

function formatUptime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function relativeTime(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

export default function AdminDiagnosticsPage() {
  const { user } = useAuth();
  const [, setLocation] = useLocation();
  const [data, setData] = useState<DiagnosticsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchDiagnostics = useCallback(async () => {
    try {
      const headers = await getAuthHeaders();
      const res = await fetch(`${API_BASE}/api/admin/email-diagnostics`, { headers });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      const json = await res.json();
      setData(json);
      setError(null);
      setLastFetched(new Date());
    } catch (err: any) {
      setError(err?.message ?? "Failed to load diagnostics");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDiagnostics();
  }, [fetchDiagnostics]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchDiagnostics, 5000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchDiagnostics]);

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="flex items-center gap-2 text-muted-foreground">
          <RefreshCw className="w-4 h-4 animate-spin" />
          <span className="text-sm">Loading diagnostics…</span>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center gap-4 p-6">
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="w-5 h-5" />
          <span className="font-medium">{error}</span>
        </div>
        <p className="text-sm text-muted-foreground text-center max-w-sm">
          Make sure your email is listed in the <code className="bg-muted px-1 rounded text-xs">ADMIN_EMAIL</code> environment variable.
        </p>
        <button
          onClick={() => setLocation("/profile")}
          className="text-sm text-primary underline-offset-2 hover:underline"
        >
          Back to profile
        </button>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div className="min-h-screen bg-background pb-16">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur border-b border-border px-4 py-3">
        <div className="max-w-3xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setLocation("/profile")}
              className="text-muted-foreground hover:text-foreground transition-colors"
              data-testid="button-back-admin"
            >
              <ArrowLeft className="w-5 h-5" />
            </button>
            <div>
              <h1 className="font-semibold text-sm">Email Diagnostics</h1>
              <p className="text-xs text-muted-foreground">
                {user?.email} · Uptime {data.serverUptime ? formatUptime(data.serverUptime) : "—"}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground cursor-pointer select-none">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={e => setAutoRefresh(e.target.checked)}
                className="rounded"
                data-testid="toggle-auto-refresh"
              />
              Auto-refresh
            </label>
            <button
              onClick={fetchDiagnostics}
              className="flex items-center gap-1 px-2 py-1 rounded-md text-xs bg-muted hover:bg-muted/80 transition-colors"
              data-testid="button-refresh-diagnostics"
            >
              <RefreshCw className="w-3 h-3" />
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="max-w-3xl mx-auto px-4 py-4 space-y-4">
        {/* Enforcement date */}
        <div className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Clock className="w-3.5 h-3.5" />
          Enforcement active since {new Date(data.enforcementDate).toLocaleDateString()}
          {lastFetched && (
            <span className="ml-2">· Last updated {relativeTime(lastFetched.toISOString())}</span>
          )}
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {[
            { label: "Total", value: data.summary.total, icon: Mail, color: "text-foreground" },
            { label: "OTPs Sent", value: data.summary.sent, icon: Mail, color: "text-blue-600" },
            { label: "Verified", value: data.summary.verified, icon: CheckCircle, color: "text-green-600" },
            { label: "Blocked", value: data.summary.blocked, icon: ShieldOff, color: "text-red-600" },
            { label: "Failed", value: data.summary.failed, icon: AlertCircle, color: "text-orange-600" },
            { label: "Rate Ltd", value: data.summary.rateLimited, icon: Clock, color: "text-amber-600" },
          ].map(({ label, value, icon: Icon, color }) => (
            <div
              key={label}
              className="rounded-lg border border-border bg-card p-2.5 text-center"
              data-testid={`stat-${label.toLowerCase().replace(/\s+/, "-")}`}
            >
              <Icon className={`w-4 h-4 mx-auto mb-1 ${color}`} />
              <p className={`text-xl font-bold leading-none ${color}`}>{value}</p>
              <p className="text-xs text-muted-foreground mt-0.5">{label}</p>
            </div>
          ))}
        </div>

        {/* Event log */}
        <div className="rounded-xl border border-border bg-card overflow-hidden">
          <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
            <h2 className="text-sm font-medium">Event log</h2>
            <span className="text-xs text-muted-foreground">{data.events.length} events (newest first)</span>
          </div>

          {data.events.length === 0 ? (
            <div className="py-12 flex flex-col items-center gap-2 text-muted-foreground">
              <ShieldCheck className="w-6 h-6" />
              <p className="text-sm">No events recorded yet</p>
              <p className="text-xs">Events populate as users sign up and verify their email.</p>
            </div>
          ) : (
            <div className="divide-y divide-border max-h-[60vh] overflow-y-auto">
              {data.events.map((ev, i) => (
                <div
                  key={i}
                  className="px-4 py-2.5 flex items-start gap-3 hover:bg-muted/30 transition-colors"
                  data-testid={`event-row-${i}`}
                >
                  <div className="flex-shrink-0 pt-0.5">
                    {ev.success ? (
                      <CheckCircle className="w-3.5 h-3.5 text-green-500" />
                    ) : (
                      <AlertCircle className="w-3.5 h-3.5 text-red-500" />
                    )}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span
                        className={`inline-block text-xs px-1.5 py-0.5 rounded border font-mono ${
                          EVENT_COLORS[ev.type] ?? "bg-muted text-muted-foreground border-border"
                        }`}
                      >
                        {ev.type}
                      </span>
                      {ev.email && (
                        <span className="text-xs text-muted-foreground font-mono">{ev.email}</span>
                      )}
                      {ev.userId && (
                        <span className="text-xs text-muted-foreground font-mono">uid:{ev.userId}</span>
                      )}
                    </div>
                    {ev.note && (
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">{ev.note}</p>
                    )}
                  </div>
                  <span className="text-xs text-muted-foreground flex-shrink-0 tabular-nums">
                    {relativeTime(ev.ts)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
