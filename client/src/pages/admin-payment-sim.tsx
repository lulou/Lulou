import { useState, useEffect, useCallback } from "react";
import { useAuth } from "@/hooks/use-auth";
import { getAuthHeaders, API_BASE } from "@/lib/queryClient";
import {
  ArrowLeft, FlaskConical, RefreshCw, CheckCircle, XCircle,
  AlertCircle, Loader2, User, ShoppingBag, RotateCcw,
} from "lucide-react";
import { useLocation } from "wouter";

// ── Types ──────────────────────────────────────────────────────────────────────

interface SimUser {
  userId: string;
  email: string;
  firstName: string;
  createdAt: string;
}

interface SimRecord {
  id: string;
  simSessionId: string;
  adminUserId: string;
  targetUserId: string;
  itemId: string | null;
  packId: string | null;
  productName: string;
  amountCents: number;
  currency: string;
  status: string;
  refundSimId: string | null;
  grantResult: string | null;
  purchaseEmailSent: boolean;
  refundEmailSent: boolean;
  errorLog: string | null;
  createdAt: string;
  refundedAt: string | null;
}

// ── Catalogue (mirrors server/purchaseItems.ts) ────────────────────────────────

const EXTRAS = [
  { id: "messages-5",           label: "+5 Messages",           price: "$4.99",  type: "item" },
  { id: "undo-close",           label: "Undo Last Pass",         price: "$2.99",  type: "item" },
  { id: "membership",           label: "Lulou Membership",       price: "$19.99", type: "item" },
  { id: "starter-pack",         label: "Starter Pack",           price: "$4.99",  type: "item" },
  { id: "video-starter",        label: "Video Call Starter",     price: "$6.99",  type: "item" },
  { id: "connection-pack",      label: "Connection Pack",        price: "$12.99", type: "item" },
  { id: "premium-pack",         label: "Premium Pack",           price: "$19.99", type: "item" },
  { id: "chemistry-pack",       label: "Chemistry Pack",         price: "$16.99", type: "item" },
  { id: "deep-connection-pack", label: "Deep Connection Pack",   price: "$27.99", type: "item" },
  { id: "voice-notes-unlock",   label: "Voice Notes Unlock",     price: "$4.99",  type: "item" },
  { id: "extra-call",           label: "Extra Call",              price: "$4.99",  type: "item" },
  { id: "sparks-1",             label: "1 Halo",                  price: "$2.99",  type: "item" },
  { id: "sparks-3",             label: "3 Halos",                 price: "$6.99",  type: "item" },
  { id: "sparks-5",             label: "5 Halos",                 price: "$9.99",  type: "item" },
] as const;

const ELEVATE_PACKS = [
  { id: "elevate-1",     label: "1 Elevate (30 min)",        price: "$9.99",  type: "pack" },
  { id: "elevate-3",     label: "3 Elevates (30 min each)",  price: "$26.99", type: "pack" },
  { id: "elevate-5",     label: "5 Elevates (30 min each)",  price: "$39.99", type: "pack" },
  { id: "super-elevate", label: "Super Elevate (60 min)",    price: "$34.99", type: "pack" },
] as const;

const ALL_PRODUCTS = [...EXTRAS, ...ELEVATE_PACKS];

// ── Helper ─────────────────────────────────────────────────────────────────────

function relTime(ts: string) {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  return `${Math.round(diff / 3_600_000)}h ago`;
}

function fmt(amountCents: number, currency: string) {
  try {
    return new Intl.NumberFormat("en-AU", {
      style: "currency", currency: currency.toUpperCase(), minimumFractionDigits: 2,
    }).format(amountCents / 100);
  } catch {
    return `${(amountCents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
}

// ── Component ──────────────────────────────────────────────────────────────────

export default function AdminPaymentSimPage() {
  const { user } = useAuth();
  const [, navigate] = useLocation();
  const [isAdmin, setIsAdmin] = useState<boolean | null>(null);

  // Form state
  const [users, setUsers]           = useState<SimUser[]>([]);
  const [targetUserId, setTargetUserId] = useState("");
  const [productType, setProductType] = useState<"item" | "pack">("item");
  const [itemId, setItemId]         = useState<string>(EXTRAS[0].id);
  const [packId, setPackId]         = useState<string>(ELEVATE_PACKS[0].id);

  // Status
  const [purchasing, setPurchasing] = useState(false);
  const [refunding, setRefunding]   = useState<string | null>(null); // simSessionId being refunded
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [loadingLogs, setLoadingLogs]   = useState(false);
  const [simulations, setSimulations]   = useState<SimRecord[]>([]);
  const [error, setError]           = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<{ type: "purchase" | "refund"; sim: SimRecord; idempotentSkip?: boolean } | null>(null);

  // ── Admin guard ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;
    getAuthHeaders().then(headers => {
      fetch(`${API_BASE}/api/admin/payment-sim/users`, { headers })
        .then(r => {
          setIsAdmin(r.ok || r.status !== 403);
          if (r.status === 403) setIsAdmin(false);
          else setIsAdmin(true);
        })
        .catch(() => setIsAdmin(false));
    });
  }, [user]);

  // ── Load users + logs ────────────────────────────────────────────────────────
  const loadUsers = useCallback(async () => {
    setLoadingUsers(true);
    try {
      const headers = await getAuthHeaders();
      const r = await fetch(`${API_BASE}/api/admin/payment-sim/users`, { headers });
      if (!r.ok) throw new Error(await r.text());
      const { users: list } = await r.json();
      setUsers(list);
      if (list.length > 0 && !targetUserId) setTargetUserId(list[0].userId);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingUsers(false);
    }
  }, [targetUserId]);

  const loadLogs = useCallback(async () => {
    setLoadingLogs(true);
    try {
      const headers = await getAuthHeaders();
      const r = await fetch(`${API_BASE}/api/admin/payment-sim/logs`, { headers });
      if (!r.ok) throw new Error(await r.text());
      const { simulations: list } = await r.json();
      setSimulations(list);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoadingLogs(false);
    }
  }, []);

  useEffect(() => {
    if (isAdmin) {
      loadUsers();
      loadLogs();
    }
  }, [isAdmin]);

  // ── Simulate purchase ────────────────────────────────────────────────────────
  const handlePurchase = async () => {
    if (!targetUserId) return;
    setPurchasing(true);
    setError(null);
    setLastResult(null);
    try {
      const headers = await getAuthHeaders();
      const body: Record<string, string> = { targetUserId };
      if (productType === "item") body.itemId = itemId;
      else body.packId = packId;

      const r = await fetch(`${API_BASE}/api/admin/payment-sim/purchase`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.message ?? r.statusText);
      setLastResult({ type: "purchase", sim: json.simulation });
      await loadLogs();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setPurchasing(false);
    }
  };

  // ── Simulate refund ──────────────────────────────────────────────────────────
  const handleRefund = async (simSessionId: string) => {
    setRefunding(simSessionId);
    setError(null);
    try {
      const headers = await getAuthHeaders();
      const r = await fetch(`${API_BASE}/api/admin/payment-sim/refund`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ simSessionId }),
      });
      const json = await r.json();
      if (!r.ok) throw new Error(json.message ?? r.statusText);
      setLastResult({ type: "refund", sim: json.simulation, idempotentSkip: json.idempotentSkip });
      await loadLogs();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setRefunding(null);
    }
  };

  // ── Render ───────────────────────────────────────────────────────────────────

  if (!user) return null;

  if (isAdmin === null) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-rose-400" />
      </div>
    );
  }

  if (isAdmin === false) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 text-center p-6">
        <AlertCircle className="w-10 h-10 text-red-400" />
        <h1 className="text-xl font-semibold">Admin Access Required</h1>
        <p className="text-sm text-gray-500">Set the ADMIN_EMAIL environment variable to your email to access this page.</p>
        <button
          onClick={() => navigate("/profile")}
          className="mt-2 text-sm text-rose-500 underline"
          data-testid="button-back-profile"
        >
          Back to Profile
        </button>
      </div>
    );
  }

  const selectedProduct = productType === "item"
    ? ALL_PRODUCTS.find(p => p.id === itemId)
    : ALL_PRODUCTS.find(p => p.id === packId);

  return (
    <div className="min-h-screen bg-gray-50" data-testid="admin-payment-sim-page">
      {/* Header */}
      <div className="bg-white border-b px-4 py-3 flex items-center gap-3 sticky top-0 z-10">
        <button
          onClick={() => navigate("/admin/diagnostics")}
          className="p-1.5 rounded-lg hover:bg-gray-100"
          data-testid="button-back-admin"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <FlaskConical className="w-5 h-5 text-rose-500" />
        <div>
          <h1 className="font-semibold text-sm leading-tight">Payment Simulator</h1>
          <p className="text-xs text-gray-400">Admin only · no real charges</p>
        </div>
        <button
          onClick={() => { loadUsers(); loadLogs(); }}
          className="ml-auto p-1.5 rounded-lg hover:bg-gray-100"
          data-testid="button-refresh-logs"
        >
          <RefreshCw className="w-4 h-4 text-gray-400" />
        </button>
      </div>

      <div className="max-w-2xl mx-auto p-4 space-y-4">
        {/* Error banner */}
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-3 py-2 rounded-lg flex items-start gap-2" data-testid="error-banner">
            <XCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Last result */}
        {lastResult && (
          <ResultCard result={lastResult} />
        )}

        {/* Simulation form */}
        <div className="bg-white rounded-xl border shadow-sm p-4 space-y-4">
          <h2 className="font-semibold text-sm flex items-center gap-2">
            <ShoppingBag className="w-4 h-4 text-rose-400" />
            Simulate Purchase
          </h2>

          {/* Target user */}
          <div data-testid="field-target-user">
            <label className="block text-xs text-gray-500 mb-1 font-medium">Target User</label>
            {loadingUsers ? (
              <div className="h-9 bg-gray-100 rounded-lg animate-pulse" />
            ) : (
              <select
                value={targetUserId}
                onChange={e => setTargetUserId(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-rose-300"
                data-testid="select-target-user"
              >
                {users.map(u => (
                  <option key={u.userId} value={u.userId}>
                    {u.firstName ? `${u.firstName} — ` : ""}{u.email || u.userId.slice(0, 12)}
                  </option>
                ))}
              </select>
            )}
          </div>

          {/* Product type tabs */}
          <div>
            <label className="block text-xs text-gray-500 mb-1 font-medium">Product Category</label>
            <div className="flex rounded-lg border overflow-hidden" data-testid="tabs-product-type">
              <button
                onClick={() => setProductType("item")}
                className={`flex-1 py-1.5 text-sm ${productType === "item" ? "bg-rose-50 text-rose-600 font-medium" : "text-gray-500 hover:bg-gray-50"}`}
                data-testid="tab-extras"
              >
                Extras & Sparks
              </button>
              <button
                onClick={() => setProductType("pack")}
                className={`flex-1 py-1.5 text-sm ${productType === "pack" ? "bg-rose-50 text-rose-600 font-medium" : "text-gray-500 hover:bg-gray-50"}`}
                data-testid="tab-elevate"
              >
                Elevate Packs
              </button>
            </div>
          </div>

          {/* Product picker */}
          <div data-testid="field-product">
            <label className="block text-xs text-gray-500 mb-1 font-medium">Product</label>
            {productType === "item" ? (
              <select
                value={itemId}
                onChange={e => setItemId(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-rose-300"
                data-testid="select-item-id"
              >
                {EXTRAS.map(p => (
                  <option key={p.id} value={p.id}>{p.label} — {p.price}</option>
                ))}
              </select>
            ) : (
              <select
                value={packId}
                onChange={e => setPackId(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-rose-300"
                data-testid="select-pack-id"
              >
                {ELEVATE_PACKS.map(p => (
                  <option key={p.id} value={p.id}>{p.label} — {p.price}</option>
                ))}
              </select>
            )}
          </div>

          {/* Selected summary */}
          {selectedProduct && (
            <div className="bg-rose-50 rounded-lg px-3 py-2 text-xs text-rose-700 flex items-center gap-1.5">
              <CheckCircle className="w-3.5 h-3.5 shrink-0" />
              <span>
                <strong>{selectedProduct.label}</strong> — {selectedProduct.price} (simulated, no charge)
              </span>
            </div>
          )}

          <button
            onClick={handlePurchase}
            disabled={purchasing || !targetUserId}
            className="w-full py-2.5 rounded-xl bg-rose-500 text-white text-sm font-medium disabled:opacity-50 flex items-center justify-center gap-2"
            data-testid="button-simulate-purchase"
          >
            {purchasing ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> Simulating…</>
            ) : (
              <><FlaskConical className="w-4 h-4" /> Simulate Purchase</>
            )}
          </button>
        </div>

        {/* Simulation logs */}
        <div className="bg-white rounded-xl border shadow-sm">
          <div className="px-4 py-3 border-b flex items-center justify-between">
            <h2 className="font-semibold text-sm">Recent Simulations</h2>
            {loadingLogs && <Loader2 className="w-4 h-4 animate-spin text-gray-400" />}
          </div>

          {simulations.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400">
              No simulations yet. Run one above.
            </div>
          ) : (
            <div className="divide-y">
              {simulations.map(sim => (
                <SimRow
                  key={sim.id}
                  sim={sim}
                  onRefund={handleRefund}
                  refunding={refunding === sim.simSessionId}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function ResultCard({ result }: { result: { type: "purchase" | "refund"; sim: SimRecord; idempotentSkip?: boolean } }) {
  const { type, sim, idempotentSkip } = result;
  const isPurchase = type === "purchase";
  const isRefund = type === "refund";

  return (
    <div
      className={`rounded-xl border-2 p-4 space-y-2 ${isPurchase ? "border-green-200 bg-green-50" : "border-blue-200 bg-blue-50"}`}
      data-testid="result-card"
    >
      <div className="flex items-center gap-2">
        <CheckCircle className={`w-5 h-5 ${isPurchase ? "text-green-600" : "text-blue-600"}`} />
        <span className="font-semibold text-sm">
          {isPurchase ? "Purchase Simulated" : idempotentSkip ? "Refund — Idempotent Skip ✓" : "Refund Simulated"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
        <Row label="Product" value={sim.productName} />
        <Row label="Amount" value={fmt(sim.amountCents, sim.currency)} />
        <Row label="Status" value={sim.status} mono />
        {isPurchase && (
          <>
            <Row label="Granted" value={sim.grantResult ? JSON.parse(sim.grantResult).join(", ") : "—"} />
            <Row label="Purchase Email" value={sim.purchaseEmailSent ? "✓ sent" : "✗ not sent"} />
          </>
        )}
        {isRefund && (
          <>
            <Row label="Refund ID" value={sim.refundSimId ?? "—"} mono />
            <Row label="Refund Email" value={idempotentSkip ? "↩ skipped (idempotent)" : sim.refundEmailSent ? "✓ sent" : "✗ not sent"} />
          </>
        )}
        <Row label="Sim Session" value={sim.simSessionId} mono />
        {sim.errorLog && <Row label="Warning" value={sim.errorLog} className="col-span-2 text-orange-600" />}
      </div>
    </div>
  );
}

function Row({ label, value, mono, className }: { label: string; value: string; mono?: boolean; className?: string }) {
  return (
    <>
      <span className={`text-gray-500 ${className ?? ""}`}>{label}</span>
      <span className={`${mono ? "font-mono text-[10px] break-all" : ""} ${className ?? ""}`}>{value}</span>
    </>
  );
}

function SimRow({
  sim,
  onRefund,
  refunding,
}: {
  sim: SimRecord;
  onRefund: (id: string) => void;
  refunding: boolean;
}) {
  const isRefunded = sim.status === "refunded";
  const canRefund = sim.status === "granted";

  return (
    <div className="px-4 py-3 flex items-start gap-3" data-testid={`sim-row-${sim.id}`}>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium truncate">{sim.productName}</span>
          <StatusBadge status={sim.status} />
        </div>
        <div className="text-xs text-gray-400 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
          <span>{fmt(sim.amountCents, sim.currency)}</span>
          <span className="flex items-center gap-1">
            <User className="w-3 h-3" />{sim.targetUserId.slice(0, 8)}…
          </span>
          <span>{relTime(sim.createdAt)}</span>
        </div>
        <div className="mt-1 flex gap-2 text-xs">
          <EmailChip label="Purchase" sent={sim.purchaseEmailSent} />
          {isRefunded && <EmailChip label="Refund" sent={sim.refundEmailSent} />}
        </div>
        {sim.errorLog && (
          <p className="text-xs text-orange-600 mt-1 truncate" title={sim.errorLog}>{sim.errorLog}</p>
        )}
        <p className="font-mono text-[9px] text-gray-300 mt-1 truncate">{sim.simSessionId}</p>
      </div>

      {canRefund && (
        <button
          onClick={() => onRefund(sim.simSessionId)}
          disabled={refunding}
          className="shrink-0 flex items-center gap-1 text-xs border border-blue-200 text-blue-600 px-2.5 py-1.5 rounded-lg hover:bg-blue-50 disabled:opacity-50"
          data-testid={`button-refund-${sim.id}`}
        >
          {refunding ? <Loader2 className="w-3 h-3 animate-spin" /> : <RotateCcw className="w-3 h-3" />}
          Refund
        </button>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    granted:       "bg-green-100 text-green-700",
    refunded:      "bg-blue-100 text-blue-700",
    grant_failed:  "bg-red-100 text-red-700",
  };
  return (
    <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${styles[status] ?? "bg-gray-100 text-gray-600"}`}>
      {status}
    </span>
  );
}

function EmailChip({ label, sent }: { label: string; sent: boolean }) {
  return (
    <span className={`flex items-center gap-0.5 ${sent ? "text-green-600" : "text-gray-400"}`}>
      {sent ? <CheckCircle className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
      {label} email
    </span>
  );
}
