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
  return "https://lulou-dating.replit.app";
})();

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
      `VITE_API_BASE_URL = https://lulou-dating.replit.app  then redeploy.`;
    console.error("[API_BASE] MISSING:", msg);
    throw new Error(msg);
  }
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

export async function getAuthHeaders(): Promise<Record<string, string>> {
  // Fast path: if a token is cached AND still valid (>60 s remaining), return it
  // immediately without any async Supabase SDK call.
  if (_cachedToken && _tokenExpiresAt * 1000 - Date.now() > 60_000) {
    return { Authorization: `Bearer ${_cachedToken}` };
  }

  // If we have a cached token but the expiry check just failed, still use it.
  // The server will return a 401 if the JWT is genuinely expired.
  if (_cachedToken) {
    console.warn("[AUTH_HEADERS] CACHED_TOKEN_EXPIRY_BYPASS", {
      tokenExpiresAt: _tokenExpiresAt,
      remainingMs: _tokenExpiresAt * 1000 - Date.now(),
    });
    return { Authorization: `Bearer ${_cachedToken}` };
  }

  // Slow path: only reached on initial page load (before INITIAL_SESSION event)
  // or immediately after logout cleared _cachedToken.
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
      return { Authorization: `Bearer ${session.access_token}` };
    }
  } catch (err: any) {
    console.error("[AUTH_HEADERS] SLOW_PATH_FAILED", { error: err?.message });
  }

  _cachedToken = null;
  console.warn("[AUTH_HEADERS] NO_TOKEN — returning empty headers");
  return {};
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

async function throwIfResNotOk(res: Response, url = "") {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    let message = `${res.status}: ${text}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed.message) message = parsed.message;
    } catch {}
    if (res.status === 404 && !API_BASE && IS_CROSS_ORIGIN_DEPLOY) {
      message =
        `API unreachable (404): VITE_API_BASE_URL is not set. ` +
        `Add it to Vercel environment variables and redeploy. Attempted: ${url}`;
    }
    throw new Error(message);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  requireApiBase(url);
  const authHeaders = await getAuthHeaders();
  // TEMP: latency debugging — remove before production release
  const t0 = PERF_ENABLED ? performance.now() : 0;
  const res = await fetch(API_BASE + url, {
    method,
    headers: {
      ...authHeaders,
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });
  if (PERF_ENABLED) {
    logLatency(`${method} ${url}`, Math.round(performance.now() - t0), parseServerTiming(res.headers.get("server-timing")), 0);
  }
  assertJsonResponse(res, url);
  await throwIfResNotOk(res, url);
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

    // TEMP: latency debugging — timer only started when PERF_ENABLED
    const t0 = PERF_ENABLED ? performance.now() : 0;
    const res = await fetch(API_BASE + url, {
      credentials: "include",
      headers: authHeaders,
    });

    if (res.status === 401) {
      endQuery({ status: 401 });
      console.warn(`[QUERY_FETCH] 401 Unauthorized for ${url}`);
      if (unauthorizedBehavior === "returnNull") return null as any;
      throw new Error("Unauthorized");
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
        ? "API unreachable — set VITE_API_BASE_URL in Vercel environment variables to your Replit backend URL, then redeploy"
        : `Unexpected response (${ct || "no content-type"}) for ${url}`;
      console.error(`[QUERY_FETCH] non-JSON response for ${url}:`, { ct, preview });
      throw new Error(msg);
    }

    const json = await res.json();

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
      retryDelay: 2000,
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
    const res = await fetch(`${API_BASE}/api/profiles/photos/batch?ids=${missing.join(",")}`, {
      headers,
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
