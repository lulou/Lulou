import { supabase } from "./supabase";
import { API_BASE } from "./queryClient";

// ── Debug state (module-level singleton) ──────────────────────────────────────
// Consumed by PurchaseDebugPanel (dev-only) and available to any component.

export interface PurchaseDebugInfo {
  product: string;
  apiBase: string;
  endpoint: string;
  hasToken: boolean;
  status: number | null;
  body: string;
  sessionId: string;
  redirectUrl: string;
  error: string;
  ts: number;
}

type DebugListener = (info: PurchaseDebugInfo | null) => void;
const _listeners = new Set<DebugListener>();
let _current: PurchaseDebugInfo | null = null;

export function subscribeDebug(fn: DebugListener): () => void {
  _listeners.add(fn);
  fn(_current);
  return () => _listeners.delete(fn);
}

function _emit(patch: Partial<PurchaseDebugInfo> | null): void {
  if (patch === null) {
    _current = null;
  } else {
    const base: PurchaseDebugInfo = _current ?? {
      product: "", apiBase: "", endpoint: "", hasToken: false,
      status: null, body: "", sessionId: "", redirectUrl: "", error: "", ts: 0,
    };
    _current = { ...base, ...patch };
  }
  _listeners.forEach(fn => fn(_current));
}

// ── startPurchase ─────────────────────────────────────────────────────────────
// Single entry point for all Stripe Checkout flows in the app.
// Handles auth token, raw fetch, debug emission, and navigation on success.
// Callers set loading state before calling; this calls onError/onLoading(false)
// only on failure (on success the page navigates away).

export interface StartPurchaseOpts {
  productId: string;
  endpoint?: string;
  body: Record<string, unknown>;
  onError?: (msg: string) => void;
}

export async function startPurchase(opts: StartPurchaseOpts): Promise<void> {
  const endpoint = opts.endpoint ?? "/api/stripe/extras-checkout";
  const fullUrl = `${API_BASE}${endpoint}`;
  const apiBase = API_BASE || "(empty=same-origin)";

  console.log(`[PURCHASE] CLICK product=${opts.productId}`);
  console.log(`[PURCHASE] PRODUCT ${opts.productId}`);
  console.log(`[PURCHASE] API_BASE "${apiBase}"`);
  console.log(`[PURCHASE] REQUEST_URL "${fullUrl}"`);

  let token: string | null = null;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    token = session?.access_token ?? null;
  } catch {}

  _emit({
    product: opts.productId,
    apiBase,
    endpoint,
    hasToken: !!token,
    status: null,
    body: "",
    sessionId: "",
    redirectUrl: "",
    error: "",
    ts: Date.now(),
  });

  try {
    const res = await fetch(fullUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(opts.body),
      credentials: "include",
    });

    const bodyText = await res.text();
    let parsed: any = null;
    try { parsed = JSON.parse(bodyText); } catch {}
    const bodyPreview = bodyText.slice(0, 400);
    const sessionId: string = parsed?.sessionId ?? parsed?.session_id ?? "";

    console.log(`[PURCHASE] RESPONSE_STATUS ${res.status}`);
    _emit({ status: res.status, body: bodyPreview, sessionId });

    if (res.ok && parsed?.url) {
      console.log(`[PURCHASE] REDIRECT_URL "${parsed.url}"`);
      _emit({ redirectUrl: parsed.url });
      sessionStorage.setItem("lulou_stripe_checkout", "1");
      window.location.assign(parsed.url);
    } else {
      const errMsg = parsed?.message ?? `HTTP ${res.status}: ${bodyPreview.slice(0, 120)}`;
      console.error(`[PURCHASE] ERROR ${errMsg}`);
      _emit({ error: errMsg });
      opts.onError?.(errMsg);
    }
  } catch (err: any) {
    const errMsg = err?.message ?? "Network error";
    console.error(`[PURCHASE] ERROR ${errMsg}`);
    _emit({ error: errMsg });
    opts.onError?.(errMsg);
  }
}

// ── restorePurchases ──────────────────────────────────────────────────────────
// Shared restore flow — idempotent, checks real Stripe sessions.

export interface RestorePurchasesOpts {
  onLoading?: (v: boolean) => void;
  onComplete?: (count: number, names: string[]) => void;
  onError?: (msg: string) => void;
}

export async function restorePurchases(opts: RestorePurchasesOpts): Promise<void> {
  console.log("[PURCHASE] RESTORE_STARTED");
  opts.onLoading?.(true);

  let token: string | null = null;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    token = session?.access_token ?? null;
  } catch {}

  try {
    const res = await fetch(`${API_BASE}/api/stripe/restore-purchases`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({}),
      credentials: "include",
    });
    let data: any = {};
    try { data = await res.json(); } catch {}
    if (!res.ok) throw new Error(data?.message ?? "Restore failed");
    const count: number = data.restored?.length ?? 0;
    const names: string[] = (data.restored ?? []).map((r: { name: string }) => r.name);
    console.log(`[PURCHASE] RESTORE_COMPLETE count=${count} items=${names.join(",")}`);
    opts.onComplete?.(count, names);
  } catch (err: any) {
    const msg = err?.message ?? "Restore failed";
    console.error(`[PURCHASE] RESTORE_ERROR ${msg}`);
    opts.onError?.(msg);
  } finally {
    opts.onLoading?.(false);
  }
}
