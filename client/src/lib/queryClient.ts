import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { preloadPhoto } from "./image-utils";
import { trackRequest, perfStart, perfMark, isMobile, scheduleIdle } from "./perf";

// ── Cross-origin deploy detection ─────────────────────────────────────────────
// Must be computed BEFORE API_BASE so the fallback can vary by host.
// Same-origin hosts (Replit dev preview, .replit.app, localhost) serve the
// Express API at the same origin, so API_BASE="" (relative URLs) is correct.
// Any other host (Vercel, custom domain) needs an explicit VITE_API_BASE_URL
// or falls back to the known production backend URL.
const _host = typeof window !== "undefined" ? window.location.hostname : "";
const _isSameOriginHost =
  _host === "" ||
  _host === "localhost" ||
  _host.endsWith(".replit.app") ||
  _host.endsWith(".replit.dev") ||
  _host.endsWith(".repl.co");

export const IS_CROSS_ORIGIN_DEPLOY: boolean = !_isSameOriginHost;

// API base URL:
//   • explicit VITE_API_BASE_URL env var → use that (strips trailing slash)
//   • same-origin host (Replit, localhost) → "" (relative URLs hit same server)
//   • cross-origin without env var        → production backend as fallback
// The OLD code put the hardcoded fallback before the same-origin check, which
// caused Replit dev previews to send requests to the production server instead
// of the local dev server — breaking dev-mode checkout logging.
export const API_BASE: string = (() => {
  const explicit = (
    (import.meta.env.VITE_API_BASE_URL as string | undefined) ||
    (import.meta.env.vite_api_base_url as string | undefined)
  )?.replace(/\/$/, "");
  if (explicit) return explicit;
  if (_isSameOriginHost) return "";
  // Production Railway backend — replaces the old lulou-dating.replit.app fallback
  return "https://lulou-production.up.railway.app";
})();

// ── Startup diagnostic: log API routing config immediately ────────────────────
// This fires at module evaluation time — before any component mounts — so it
// appears at the very top of the console on every page load.  Lets us confirm
// VITE_API_BASE_URL is set correctly in the production Vercel build.
console.log("[STARTUP_DIAG] API routing config", {
  hostname: _host,
  IS_CROSS_ORIGIN_DEPLOY,
  API_BASE: API_BASE || "(empty — same-origin relative URLs)",
  VITE_API_BASE_URL: (import.meta.env.VITE_API_BASE_URL as string | undefined) || "(not set)",
});

/**
 * Throws a clear, actionable error when VITE_API_BASE_URL is missing in a
 * cross-origin deployment.  Call this before every fetch to /api/... so
 * callers fail immediately with an explanation instead of a silent 404.
 *
 * No-op on same-origin hosts (Replit fullstack, localhost).
 */
export function requireApiBase(url: string): void {
  if (IS_CROSS_ORIGIN_DEPLOY && !API_BASE) {
    const msg =
      `VITE_API_BASE_URL is not set — cannot reach ${url} from host "${_host}". ` +
      `Go to Vercel → Settings → Environment Variables and add: ` +
      `VITE_API_BASE_URL = https://lulou-production.up.railway.app  then redeploy.`;
    console.error("[API_BASE] MISSING:", msg);
    throw new Error(msg);
  }
}

/**
 * Logs pre-fetch TypeErrors (CORS/CSP/network failures) without exposing tokens.
 * A TypeError from fetch() means the browser blocked or dropped the request
 * before receiving a response — common causes: CSP connect-src, CORP header,
 * or a network-level failure. Call this in every fetch catch block.
 */
export function logPrefetchError(url: string, err: unknown, method = "GET"): void {
  const isTypeError = err instanceof TypeError;
  const msg = err instanceof Error ? err.message : String(err);
  console.error("[PREFETCH_FAIL]", {
    method,
    // Strip query-string to avoid leaking tokens in URL params
    url: url.replace(/\?.*/, ""),
    errClass: isTypeError ? "TypeError (CORS/CSP/network block)" : "Error",
    msg,
    apiBase: API_BASE || "(empty — same-origin)",
    isCrossOrigin: IS_CROSS_ORIGIN_DEPLOY,
    host: typeof window !== "undefined" ? window.location.hostname : "SSR",
    hint: isTypeError
      ? "Check DevTools → Console for a 'Content Security Policy' or 'CORS' error above this line."
      : "Non-network error — check stack trace.",
  });
}

// TEMP: latency debugging — remove before production release
// Toggle: localStorage.setItem("lulou_perf", "1") then refresh to enable.
//         localStorage.removeItem("lulou_perf") then refresh to disable.
// Default is OFF so normal users pay zero cost.
export const PERF_ENABLED =
  typeof localStorage !== "undefined" && localStorage.getItem("lulou_perf") === "1";

if (PERF_ENABLED) {
  console.log("[LATENCY_DEBUG] instrumentation active — disable with localStorage.removeItem('lulou_perf')");
}

// In-memory auth token cache — avoids getSession() round-trip on every request
let _cachedToken: string | null = null;
let _tokenExpiresAt: number = 0;

/** Called by use-auth.ts whenever the session changes */
export function setCachedToken(token: string | null, expiresAt?: number) {
  _cachedToken = token;
  // Never store 0 — a missing expiresAt means "treat as valid for 1 hour"
  // so the fast path in getAuthHeaders() still fires and avoids a slow
  // supabase.auth.getSession() call on every query.
  _tokenExpiresAt = (expiresAt && expiresAt > 0)
    ? expiresAt
    : Math.floor(Date.now() / 1000) + 3600;
}

function buildAuthenticatedHeaders(accessToken: string): Record<string, string> {
  const sessionId = getAppSessionId();
  return {
    Authorization: `Bearer ${accessToken}`,
    ...(sessionId ? { "X-Session-Id": sessionId } : {}),
  };
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  // Fast path: if a token is cached AND still valid (>60 s remaining), return it
  // immediately without any async Supabase SDK call.
  if (_cachedToken && _tokenExpiresAt * 1000 - Date.now() > 60_000) {
    return buildAuthenticatedHeaders(_cachedToken);
  }

  // Near-expiry / expired path: token exists but < 60 s left (or already expired).
  // DO NOT send the stale token — the server will return 401, and TanStack Query
  // will retry 3× with the same expired token, then show the reconnect screen.
  // Instead, attempt a silent session refresh here so the caller gets a live token.
  if (_cachedToken) {
    const remainingMs = _tokenExpiresAt * 1000 - Date.now();
    console.warn("[AUTH_HEADERS] TOKEN_NEAR_EXPIRY — attempting silent refresh before fetch", {
      tokenExpiresAt: _tokenExpiresAt,
      remainingMs,
    });
    try {
      const { data, error } = await supabase.auth.refreshSession();
      if (data.session?.access_token) {
        const newExpiresAt: number | undefined = (data.session as any).expires_at;
        _cachedToken = data.session.access_token;
        _tokenExpiresAt = (newExpiresAt && newExpiresAt > 0)
          ? newExpiresAt
          : Math.floor(Date.now() / 1000) + 3600;
        console.log("[AUTH_HEADERS] SILENT_REFRESH_SUCCESS", { newExpiresAt });
        return buildAuthenticatedHeaders(data.session.access_token);
      }
      console.warn("[AUTH_HEADERS] SILENT_REFRESH_RETURNED_NO_SESSION", { error: error?.message });
    } catch (refreshErr: any) {
      console.warn("[AUTH_HEADERS] SILENT_REFRESH_EXCEPTION", { error: refreshErr?.message });
    }
    // Refresh failed — fall through to the slow path (getSession may still work)
    _cachedToken = null;
  }

  // Slow path: only reached on initial page load (before INITIAL_SESSION event)
  // or after a failed refresh cleared _cachedToken.
  console.log("[AUTH_HEADERS] SLOW_PATH — no cached token, calling getSession()");
  try {
    const sessionPromise = supabase.auth.getSession();
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("getSession timeout after 5 s")), 5000)
    );

    const { data: { session } } = await Promise.race([sessionPromise, timeoutPromise]);

    if (session?.access_token) {
      const expiresAt: number | undefined = (session as any).expires_at;
      _cachedToken = session.access_token;
      _tokenExpiresAt = (expiresAt && expiresAt > 0)
        ? expiresAt
        : Math.floor(Date.now() / 1000) + 3600;
      console.log("[AUTH_HEADERS] SLOW_PATH_SUCCESS", { expiresAt });
      return buildAuthenticatedHeaders(session.access_token);
    }
  } catch (err: any) {
    console.error("[AUTH_HEADERS] SLOW_PATH_FAILED", { error: err?.message });
  }

  _cachedToken = null;
  console.warn("[AUTH_HEADERS] NO_TOKEN — returning empty headers");
  return {};
}

/**
 * Force a Supabase session refresh and update the in-memory token cache.
 * Call this before manually retrying a failed profile fetch so the next
 * getAuthHeaders() call gets a live token instead of the stale cached one.
 * Returns true if a fresh token was obtained, false otherwise.
 */
export async function refreshAuthToken(): Promise<boolean> {
  console.log("[AUTH_HEADERS] MANUAL_REFRESH — forcing Supabase session refresh");
  try {
    const { data, error } = await supabase.auth.refreshSession();
    if (data.session?.access_token) {
      const newExpiresAt: number | undefined = (data.session as any).expires_at;
      setCachedToken(data.session.access_token, newExpiresAt);
      console.log("[AUTH_HEADERS] MANUAL_REFRESH_SUCCESS", { newExpiresAt });
      return true;
    }
    console.warn("[AUTH_HEADERS] MANUAL_REFRESH_NO_SESSION", { error: error?.message });
    setCachedToken(null);
    return false;
  } catch (err: any) {
    console.warn("[AUTH_HEADERS] MANUAL_REFRESH_EXCEPTION", { error: err?.message });
    setCachedToken(null);
    return false;
  }
}

// Detect when a response is non-JSON (e.g. Vercel returning index.html for an
// unmatched /api/* path).  res.ok may still be true (200) so the status check
// alone won't catch it.  Safari throws "The string did not match the expected
// pattern." from JSON.parse(html) — Chrome throws "Unexpected token '<'".
function assertJsonResponse(res: Response, url: string): void {
  const ct = res.headers.get("content-type") ?? "";
  if (res.ok && !ct.includes("application/json") && !ct.includes("text/plain")) {
    const msg = API_BASE
      ? `Unexpected non-JSON response from ${API_BASE}${url} (content-type: ${ct || "none"})`
      : `API unreachable: VITE_API_BASE_URL is not set — set it to your Replit backend URL in Vercel and redeploy. Attempted: ${url}`;
    console.error("[API] non-JSON 200:", { url, ct, API_BASE: API_BASE || "(empty)" });
    throw new Error(msg);
  }
}

async function throwIfResNotOk(res: Response, url = "", sentSessionId = "") {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    let message = `${res.status}: ${text}`;
    let parsed: any = null;
    try { parsed = JSON.parse(text); if (parsed.message) message = parsed.message; } catch {}
    if (res.status === 404 && !API_BASE && IS_CROSS_ORIGIN_DEPLOY) {
      message =
        `API unreachable (404): VITE_API_BASE_URL is not set. ` +
        `Add it to Vercel environment variables and redeploy. Attempted: ${url}`;
    }
    // If the server tells us our session was replaced by another device,
    // dispatch a window event so AuthProvider can force a local sign-out
    // and show "This account was signed in on another device."
    //
    // STALE-REQUEST GUARD: If the session ID we sent with this request no
    // longer matches the current localStorage value, INITIAL_SESSION bootstrap
    // ran and completed while this request was in-flight.  The server cached
    // the old session as "session_replaced" (even for same-device bootstrap in
    // older server versions) and fast-rejected this stale request.  Do NOT
    // dispatch the forced-logout event in this case — it is a false positive.
    // Only dispatch when sentSessionId === currentSessionId, which means the
    // session has NOT changed on this device → the replacement was genuine
    // (another device logged in).
    if (res.status === 401 && parsed?.message === "session_replaced") {
      const currentSessionId = getAppSessionId();
      if (!sentSessionId || sentSessionId === currentSessionId) {
        console.warn("[SESSION] session_replaced in API response — dispatching forced-logout event", { url });
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("lulou:session-replaced"));
        }
      } else {
        console.warn("[SESSION] session_replaced on STALE apiRequest — ignored (bootstrap completed during flight)", {
          url,
          sentPrefix: sentSessionId.slice(0, 8) + "…",
          currentPrefix: currentSessionId ? currentSessionId.slice(0, 8) + "…" : "(none)",
        });
      }
    }
    throw new Error(message);
  }
}

/** Returns the application session ID stored for this browser, or "". */
export function getAppSessionId(): string {
  try { return localStorage.getItem("lulou_session_id") ?? ""; } catch { return ""; }
}

// _attemptSessionReregistration has been removed.
// 401 invalid_session from a protected query now dispatches
// "lulou:session-bootstrap-needed" so the auth layer can show the
// Retry / Sign out screen.  Queries must never bypass the session gate.

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  requireApiBase(url);
  const authHeaders = await getAuthHeaders();
  // TEMP: latency debugging — remove before production release
  const t0 = PERF_ENABLED ? performance.now() : 0;
  const sessionId = getAppSessionId();
  let res: Response;
  try {
    res = await fetch(API_BASE + url, {
      method,
      headers: {
        ...authHeaders,
        ...(data ? { "Content-Type": "application/json" } : {}),
        // Tell the server which application session this request belongs to.
        // The isAuthenticated middleware checks this against active_sessions and
        // returns 401 session_replaced if the session was replaced by another device.
        ...(sessionId ? { "X-Session-Id": sessionId } : {}),
      },
      body: data ? JSON.stringify(data) : undefined,
      credentials: "include",
    });
  } catch (fetchErr) {
    logPrefetchError(API_BASE + url, fetchErr, method);
    throw fetchErr;
  }
  if (PERF_ENABLED) {
    logLatency(`${method} ${url}`, Math.round(performance.now() - t0), parseServerTiming(res.headers.get("server-timing")), 0);
  }
  assertJsonResponse(res, url);
  await throwIfResNotOk(res, url, sessionId);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";

// TEMP: latency debugging — remove before production release
// Parse a Server-Timing header and return the named metric in ms.
// Only called when PERF_ENABLED — not on every request.
export function parseServerTiming(header: string | null, metric = "handler"): number | null {
  if (!header) return null;
  const re = new RegExp(`${metric}[^,]*?dur=([\\d.]+)`);
  const m = header.match(re);
  return m ? parseFloat(m[1]) : null;
}

// TEMP: latency debugging — remove before production release
// Emits one [LATENCY] line per request when PERF_ENABLED.
export function logLatency(
  url: string,
  clientMs: number,
  serverMs: number | null,
  payloadKb: number,
): void {
  if (!PERF_ENABLED) return;
  const parts: string[] = [`[LATENCY] ${url}`, `client=${clientMs}ms`];
  if (serverMs != null) {
    parts.push(`server=${Math.round(serverMs)}ms`);
    const networkMs = Math.round(clientMs - serverMs);
    parts.push(`network=${networkMs}ms`);
    if (networkMs > 300) parts.push("HIGH_NETWORK");
  } else {
    parts.push("server=missing", "network=unknown");
  }
  if (payloadKb > 0) parts.push(`payload=${payloadKb}kB`);
  console.log(parts.join(" | "));
}

export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const url = queryKey.join("/") as string;

    requireApiBase(url);

    // Dev-only: detect duplicate fetches and time each request
    trackRequest(url);
    // Warn if a photo was requested individually despite batch prefetch
    if (import.meta.env.DEV && /\/api\/profiles\/[^/]+\/photos$/.test(url)) {
      perfMark("PHOTO_CACHE_MISS", { url });
    }
    const endQuery = perfStart(`QUERY:${url}`);

    const authHeaders = await getAuthHeaders();
    const sessionId = getAppSessionId();

    // TEMP: latency debugging — timer only started when PERF_ENABLED
    const t0 = PERF_ENABLED ? performance.now() : 0;
    let res: Response;
    try {
      res = await fetch(API_BASE + url, {
        credentials: "include",
        headers: {
          ...authHeaders,
          ...(sessionId ? { "X-Session-Id": sessionId } : {}),
        },
      });
    } catch (fetchErr) {
      logPrefetchError(API_BASE + url, fetchErr);
      throw fetchErr;
    }

    if (res.status === 401) {
      endQuery({ status: 401 });
      let body: any = {};
      try { body = await res.clone().json(); } catch {}

      if (body?.message === "session_replaced") {
        // STALE-REQUEST GUARD (mirrors the guard in throwIfResNotOk):
        // If bootstrap ran while this query was in-flight, the current
        // localStorage session ID will differ from what was sent (sessionId
        // was captured before the fetch).  A genuine cross-device replacement
        // leaves the local session ID unchanged (no bootstrap on this device).
        const currentSessionId = getAppSessionId();
        if (!sessionId || sessionId === currentSessionId) {
          // Session unchanged on this device → genuine replacement.
          console.warn(`[SESSION] session_replaced on query ${url} — dispatching forced-logout event`);
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("lulou:session-replaced"));
          }
        } else {
          // Session changed → stale in-flight query; bootstrap already completed.
          console.warn(`[SESSION] session_replaced on STALE query — ignored (bootstrap completed during flight)`, {
            url,
            sentPrefix: sessionId.slice(0, 8) + "…",
            currentPrefix: currentSessionId ? currentSessionId.slice(0, 8) + "…" : "(none)",
          });
        }
        if (unauthorizedBehavior === "returnNull") return null as any;
        throw new Error("session_replaced");
      }

      if (body?.message === "invalid_session") {
        // A protected query returned 401 invalid_session.
        //
        // STALE-REQUEST GUARD: if bootstrap ran while this query was in-flight,
        // the sessionId captured before the fetch will differ from what is now
        // in localStorage.  That means THIS device bootstrapped mid-flight and
        // the server correctly rejected the old ID.  Dispatching
        // lulou:session-bootstrap-needed in that case would trigger a spurious
        // retry screen even though bootstrap already succeeded.  Instead, let
        // React Query retry silently with the new session ID.
        const currentSessionId = getAppSessionId();
        const isStaleRequest =
          // Old session ID was non-empty and has changed (bootstrap stored new one)
          (!!sessionId && sessionId !== currentSessionId) ||
          // OR no session ID at all was sent (empty string means bootstrap was
          // still in-flight when we captured it)
          (!sessionId && !!currentSessionId);

        // Capture rich diagnostics to sessionStorage for the Discover error panel,
        // regardless of whether this is stale.  The panel reads these on render.
        const _diagKey = url.includes("/discover") ? "lulou_diag_discover_error" : null;
        if (_diagKey) {
          try {
            sessionStorage.setItem(_diagKey, JSON.stringify({
              ts: Date.now(),
              url,
              httpStatus: 401,
              serverMessage: body?.message,
              serverReason: body?.reason,
              sentSessionIdPrefix: sessionId ? sessionId.slice(0, 8) + "…" : "(none)",
              currentSessionIdPrefix: currentSessionId ? currentSessionId.slice(0, 8) + "…" : "(none)",
              isStaleRequest,
              lastAuthEvent: (() => { try { return localStorage.getItem("lulou_diag_last_auth_event"); } catch { return null; } })(),
              bootstrapStatus: (() => { try { return localStorage.getItem("lulou_diag_bootstrap_status"); } catch { return null; } })(),
              verifyResult: (() => { try { return localStorage.getItem("lulou_diag_verify_result"); } catch { return null; } })(),
            }));
          } catch {}
        }

        console.warn(`[SESSION] invalid_session on query ${url}`, {
          isStaleRequest,
          sentPrefix: sessionId ? sessionId.slice(0, 8) + "…" : "(none)",
          currentPrefix: currentSessionId ? currentSessionId.slice(0, 8) + "…" : "(none)",
          serverReason: body?.reason,
        });

        if (!isStaleRequest) {
          // Genuine invalid session — signal auth layer to show Retry screen.
          if (typeof window !== "undefined") {
            window.dispatchEvent(new CustomEvent("lulou:session-bootstrap-needed"));
          }
          if (unauthorizedBehavior === "returnNull") return null as any;
          throw new Error("invalid_session");
        }
        // Stale request: bootstrap completed while this request was in-flight.
        // Throw a distinct error code so the retryDelay function returns 0 —
        // React Query will re-run getQueryFn immediately with the fresh session
        // ID already in localStorage (no 2 s wait, no retry screen, no logout).
        console.warn(`[SESSION] invalid_session on STALE query — retrying immediately with fresh session ID`, { url });
        if (unauthorizedBehavior === "returnNull") return null as any;
        throw new Error("invalid_session_stale");
      }

      console.warn(`[QUERY_FETCH] 401 Unauthorized for ${url}`, body);
      if (unauthorizedBehavior === "returnNull") return null as any;
      throw new Error(body?.message || "Unauthorized");
    }

    if (!res.ok) {
      let message = `${res.status}`;
      try {
        const text = await res.text();
        const trimmed = text.slice(0, 300);
        try {
          const parsed = JSON.parse(trimmed);
          message = parsed.message || parsed.error || `${res.status}: ${trimmed}`;
        } catch {
          message = `${res.status}: ${trimmed}`;
        }
      } catch {}
      if (res.status === 404 && !API_BASE && IS_CROSS_ORIGIN_DEPLOY) {
        message =
          `API unreachable (404): VITE_API_BASE_URL is not set. ` +
          `Add it to Vercel environment variables and redeploy. Attempted: ${url}`;
      }
      endQuery({ status: res.status, error: true });
      console.error(`[QUERY_FETCH] ✗ ${url} — ${message}`);
      throw new Error(message);
    }

    // Guard: non-JSON 200 means we hit a static host instead of the backend.
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) {
      const preview = await res.text().catch(() => "").then(t => t.slice(0, 80));
      endQuery({ status: res.status, error: true });
      const isHtml = preview.trimStart().toLowerCase().startsWith("<");
      const msg = isHtml
        ? "API unreachable — set VITE_API_BASE_URL in Vercel environment variables to https://lulou-production.up.railway.app, then redeploy"
        : `Unexpected response (${ct || "no content-type"}) for ${url}`;
      console.error(`[QUERY_FETCH] non-JSON response for ${url}:`, { ct, preview });
      throw new Error(msg);
    }

    const json = await res.json();

    // Candidate feed routes keep returning arrays for compatibility with older
    // clients, while carrying safe empty-state metadata in response headers.
    // Make that metadata available to the two feed pages without changing the
    // shape consumed by existing callers.
    if (Array.isArray(json) && (url === "/api/discover" || url === "/api/popular")) {
      Object.defineProperties(json, {
        emptyReason: {
          value: res.headers.get("x-empty-reason") || "none",
          enumerable: false,
          configurable: true,
        },
        radiusMiles: {
          value: Number(res.headers.get("x-feed-radius-miles") ?? 0),
          enumerable: false,
          configurable: true,
        },
      });
    }

    // TEMP: latency debugging — expensive ops only run when PERF_ENABLED
    if (PERF_ENABLED) {
      const clientMs = Math.round(performance.now() - t0);
      const serverMs = parseServerTiming(res.headers.get("server-timing"));
      const payloadKb = Math.round(JSON.stringify(json).length / 1024);
      logLatency(url, clientMs, serverMs, payloadKb);
      endQuery({ status: 200, payloadKb });
    } else {
      endQuery({ status: 200 });
    }

    return json;
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: 1,
      // Stale invalid_session (bootstrap ran mid-flight): retry immediately so
      // the user never sees a 2 s delay — the fresh session ID is already in
      // localStorage by the time this fires.  All other errors keep the 2 s gap
      // to avoid hammering a server that is genuinely struggling.
      retryDelay: (_: number, error: unknown) =>
        error instanceof Error && error.message === "invalid_session_stale" ? 0 : 2000,
    },
    mutations: {
      retry: false,
    },
  },
});

// ── Batch photo prefetcher ────────────────────────────────────────────────────
const PHOTO_CACHE_STALE_MS = 5 * 60 * 1000;

export async function batchPrefetchPhotos(userIds: string[]): Promise<void> {
  if (!userIds.length) return;

  // Skip silently in cross-origin deploys without API_BASE — requireApiBase
  // would throw and the individual card useQuery hooks serve as fallback.
  if (IS_CROSS_ORIGIN_DEPLOY && !API_BASE) return;

  const now = Date.now();
  const missing = userIds.filter(id => {
    if (!id) return false;
    const state = queryClient.getQueryState(["/api/profiles", id, "photos"]);
    if (!state || state.dataUpdatedAt === 0) return true;
    return now - state.dataUpdatedAt > PHOTO_CACHE_STALE_MS;
  });

  if (!missing.length) return;

  const endBatch = perfStart("BATCH_PREFETCH", { requested: missing.length });

  try {
    const headers = await getAuthHeaders();
    // TEMP: latency debugging — timer only started when PERF_ENABLED
    const t0 = PERF_ENABLED ? performance.now() : 0;
    const batchSessionId = getAppSessionId();
    const res = await fetch(`${API_BASE}/api/profiles/photos/batch?ids=${missing.join(",")}`, {
      headers: {
        ...headers,
        ...(batchSessionId ? { "X-Session-Id": batchSessionId } : {}),
      },
      credentials: "include",
    });
    if (!res.ok) { endBatch({ error: res.status }); return; }

    const data: Record<string, string[]> = await res.json();

    // TEMP: latency debugging — expensive ops only run when PERF_ENABLED
    if (PERF_ENABLED) {
      const clientMs = Math.round(performance.now() - t0);
      const serverMs = parseServerTiming(res.headers.get("server-timing"));
      const payloadKb = Math.round(JSON.stringify(data).length / 1024);
      logLatency(`/api/profiles/photos/batch?n=${missing.length}`, clientMs, serverMs, payloadKb);
      endBatch({ returned: Object.keys(data).length, payloadKb });
    } else {
      endBatch({ returned: Object.keys(data).length });
    }

    for (const [userId, photos] of Object.entries(data)) {
      queryClient.setQueryData(["/api/profiles", userId, "photos"], { photos });
      if (photos[0]) {
        if (isMobile) scheduleIdle(() => preloadPhoto(photos[0]));
        else preloadPhoto(photos[0]);
      }
    }
  } catch {
    endBatch({ error: "exception" });
  }
}
