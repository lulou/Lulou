import { QueryClient, QueryFunction } from "@tanstack/react-query";
import { supabase } from "./supabase";

// In-memory auth token cache — avoids getSession() round-trip on every request
let _cachedToken: string | null = null;
let _tokenExpiresAt: number = 0;

/** Called by use-auth.ts whenever the session changes */
export function setCachedToken(token: string | null, expiresAt?: number) {
  _cachedToken = token;
  _tokenExpiresAt = expiresAt ?? 0;
}

export async function getAuthHeaders(): Promise<Record<string, string>> {
  // Fast path: return cached token if still valid (>60s remaining)
  if (_cachedToken && _tokenExpiresAt * 1000 - Date.now() > 60_000) {
    return { Authorization: `Bearer ${_cachedToken}` };
  }

  // Slow path: read from Supabase storage (only on first load or near expiry)
  const { data: { session } } = await supabase.auth.getSession();
  if (session?.access_token) {
    const expiresAt: number | undefined = (session as any).expires_at;
    if (expiresAt != null && expiresAt * 1000 - Date.now() < 60_000) {
      const { data: refreshed } = await supabase.auth.refreshSession();
      if (refreshed.session?.access_token) {
        _cachedToken = refreshed.session.access_token;
        _tokenExpiresAt = (refreshed.session as any).expires_at ?? 0;
        return { Authorization: `Bearer ${_cachedToken}` };
      }
    }
    _cachedToken = session.access_token;
    _tokenExpiresAt = expiresAt ?? 0;
    return { Authorization: `Bearer ${session.access_token}` };
  }

  // No session — try a passive refresh once
  const { data: refreshed } = await supabase.auth.refreshSession();
  if (refreshed.session?.access_token) {
    _cachedToken = refreshed.session.access_token;
    _tokenExpiresAt = (refreshed.session as any).expires_at ?? 0;
    return { Authorization: `Bearer ${_cachedToken}` };
  }

  _cachedToken = null;
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
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const url = queryKey.join("/") as string;
    const authHeaders = await getAuthHeaders();

    console.log(`[QUERY_FETCH] → ${url}`);

    const res = await fetch(url, {
      credentials: "include",
      headers: authHeaders,
    });

    if (res.status === 401) {
      console.warn(`[QUERY_FETCH] 401 Unauthorized for ${url} — auth token may not have propagated yet`);
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
      console.error(`[QUERY_FETCH] ✗ ${url} — HTTP ${res.status}: ${message}`);
      // Throw so TanStack Query sets isError=true and pages can show error/retry UI.
      // Previously this returned null, which made queries appear "successful" even when
      // the server returned an error — pages silently showed empty states forever.
      throw new Error(message);
    }

    const json = await res.json();
    console.log(`[QUERY_FETCH] ✓ ${url} — ${Array.isArray(json) ? json.length + " items" : typeof json}`);
    return json;
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "returnNull" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      // Allow one automatic retry for transient failures (cold-start, auth race,
      // network blip).  Previously retry: false meant a single failed fetch on
      // first mount was cached as success(null) forever.
      retry: 1,
      retryDelay: 2000,
    },
    mutations: {
      retry: false,
    },
  },
});
