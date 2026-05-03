import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { supabase } from "./supabase";
import { preloadPhoto } from "./image-utils";
import { trackRequest, perfStart, perfMark, isMobile, scheduleIdle } from "./perf";

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

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    let message = `${res.status}: ${text}`;
    try {
      const parsed = JSON.parse(text);
      if (parsed.message) message = parsed.message;
    } catch {}
    throw new Error(message);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const authHeaders = await getAuthHeaders();
  const res = await fetch(url, {
    method,
    headers: {
      ...authHeaders,
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
    credentials: "include",
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
/**
 * Parse a Server-Timing header and return the value of the named metric in ms.
 * Format: "handler;dur=123" or "handler;dur=123.4;desc=..."
 * Returns null if the header is absent or unparseable.
 */
function parseServerTiming(header: string | null, metric = "handler"): number | null {
  if (!header) return null;
  const re = new RegExp(`${metric}[^,]*?dur=([\\d.]+)`);
  const m = header.match(re);
  return m ? parseFloat(m[1]) : null;
}

// TEMP: latency debugging — remove before production release
function logLatency(
  url: string,
  clientMs: number,
  serverMs: number | null,
  payloadKb: number,
): void {
  const parts: string[] = [`[LATENCY] ${url}`, `client=${clientMs}ms`];
  if (serverMs != null) {
    parts.push(`server=${Math.round(serverMs)}ms`);
    const networkMs = Math.round(clientMs - serverMs);
    parts.push(`network=${networkMs}ms`);
    if (networkMs > 300) parts.push("HIGH_NETWORK");
  }
  if (payloadKb > 0) parts.push(`payload=${payloadKb}kB`);
  // console.log (not .info) — Safari hides .info by default in Web Inspector
  // eslint-disable-next-line no-console
  console.log(parts.join(" | "));
}

export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const url = queryKey.join("/") as string;

    // Dev-only: detect duplicate fetches and time each request
    trackRequest(url);
    // Warn if a photo was requested individually despite batch prefetch
    if (import.meta.env.DEV && /\/api\/profiles\/[^/]+\/photos$/.test(url)) {
      perfMark("PHOTO_CACHE_MISS", { url });
    }
    const endQuery = perfStart(`QUERY:${url}`);

    const authHeaders = await getAuthHeaders();

    const t0 = performance.now();
    const res = await fetch(url, {
      credentials: "include",
      headers: authHeaders,
    });
    // Read Server-Timing header immediately — before consuming the body,
    // so server-side processing time is captured as accurately as possible.
    const serverMs = parseServerTiming(res.headers.get("server-timing"));

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
      endQuery({ status: res.status, error: true });
      console.error(`[QUERY_FETCH] ✗ ${url} — ${message}`);
      throw new Error(message);
    }

    const json = await res.json();
    const clientMs = Math.round(performance.now() - t0);
    const payloadKb = Math.round(JSON.stringify(json).length / 1024);
    logLatency(url, clientMs, serverMs, payloadKb);
    endQuery({ status: 200, payloadKb });
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
// Fetches photos for multiple profiles in a single HTTP request (server runs
// all Supabase lookups in parallel), then writes each result into its own
// ["/api/profiles", userId, "photos"] cache slot.
//
// This converts the per-card waterfall (N individual requests that fire after
// each card mounts) into a single pre-population step that fires as soon as the
// list data arrives.  Individual card useQuery hooks then read from cache
// immediately and never issue a network request.
//
// The function is idempotent: profiles whose photo cache is still fresh
// (< 5 minutes old) are silently skipped so it is safe to call on every
// list update without triggering duplicate fetches.
const PHOTO_CACHE_STALE_MS = 5 * 60 * 1000;

export async function batchPrefetchPhotos(userIds: string[]): Promise<void> {
  if (!userIds.length) return;

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
    const t0 = performance.now();
    const res = await fetch(`/api/profiles/photos/batch?ids=${missing.join(",")}`, {
      headers,
      credentials: "include",
    });
    const serverMs = parseServerTiming(res.headers.get("server-timing"));
    if (!res.ok) { endBatch({ error: res.status }); return; }

    const data: Record<string, string[]> = await res.json();
    const clientMs = Math.round(performance.now() - t0);
    const payloadKb = Math.round(JSON.stringify(data).length / 1024);
    logLatency(`/api/profiles/photos/batch?n=${missing.length}`, clientMs, serverMs, payloadKb);

    for (const [userId, photos] of Object.entries(data)) {
      queryClient.setQueryData(["/api/profiles", userId, "photos"], { photos });
      // Kick off image decode. On mobile, defer to idle so the decode job
      // doesn't compete with the first React render on the main thread.
      // On desktop, fire immediately — plenty of cores available.
      if (photos[0]) {
        if (isMobile) scheduleIdle(() => preloadPhoto(photos[0]));
        else preloadPhoto(photos[0]);
      }
    }
    endBatch({ returned: Object.keys(data).length, payloadKb });
  } catch {
    endBatch({ error: "exception" });
    // Best-effort — individual card useQuery hooks serve as the guaranteed fallback
  }
}
