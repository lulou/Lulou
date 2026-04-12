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
    try {
      const authHeaders = await getAuthHeaders();
      const url = queryKey.join("/") as string;
      const res = await fetch(url, {
        credentials: "include",
        headers: authHeaders,
      });

      if (res.status === 401) {
        if (unauthorizedBehavior === "returnNull") return null;
        throw new Error("Unauthorized");
      }

      if (!res.ok) {
        const text = (await res.text()) || res.statusText;
        console.error(`QUERY_ERROR [${url}]`, res.status, text);
        return null;
      }

      return await res.json();
    } catch (err) {
      console.error(`QUERY_ERROR [${queryKey.join("/")}]`, err);
      return null;
    }
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "returnNull" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
