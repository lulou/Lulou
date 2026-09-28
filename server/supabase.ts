import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";

export type AdminCapabilityState = "not_initialized" | "checking" | "available" | "unavailable";
export type AdminUnavailableReason = "missing_key" | "malformed_key" | "probe_failed";

export class AdminUnavailableError extends Error {
  readonly code = "ADMIN_UNAVAILABLE";
  readonly reason: AdminUnavailableReason;

  constructor(reason: AdminUnavailableReason) {
    super("Privileged Supabase capability is unavailable");
    this.name = "AdminUnavailableError";
    this.reason = reason;
  }
}

type AdminManagerOptions = {
  url: string;
  serviceRoleKey?: string;
  timeoutMs?: number;
  createClient?: (url: string, key: string, options: any) => SupabaseClient;
};

const isValidServiceRoleJwt = (key: string | undefined): boolean => {
  if (!key) return false;
  try {
    const parts = key.split(".");
    if (parts.length !== 3 || parts.some(part => !part)) return false;
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
    return payload?.role === "service_role";
  } catch {
    return false;
  }
};

const realtimeOpts = { transport: ws as any };

export function createAdminCapabilityManager(options: AdminManagerOptions) {
  const timeoutMs = options.timeoutMs ?? 2_000;
  let state: AdminCapabilityState = "not_initialized";
  let reason: AdminUnavailableReason | null = null;
  let client: SupabaseClient | null = null;
  let initializePromise: Promise<void> | null = null;
  const clientFactory = options.createClient ?? createClient;

  const fail = (failure: AdminUnavailableReason): never => {
    state = "unavailable";
    reason = failure;
    client = null;
    throw new AdminUnavailableError(failure);
  };

  async function initialize(): Promise<void> {
    if (state === "available") return;
    if (initializePromise) return initializePromise;
    initializePromise = (async () => {
      state = "checking";
      reason = null;
      if (!options.serviceRoleKey) fail("missing_key");
      if (!isValidServiceRoleJwt(options.serviceRoleKey)) fail("malformed_key");
      let origin: string;
      try {
        origin = new URL(options.url).origin;
      } catch {
        fail("probe_failed");
      }
      let probing = true;
      const candidate = clientFactory(origin!, options.serviceRoleKey!, {
        auth: { autoRefreshToken: false, persistSession: false },
        realtime: realtimeOpts,
        global: {
          fetch: (input: any, init?: any) =>
            globalThis.fetch(input, probing
              ? { ...init, signal: AbortSignal.timeout(timeoutMs) }
              : init),
        },
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const probe = await Promise.race([
          // profiles.user_id exists in the currently deployed schema. The
          // quota-consumption table is not a safe pre-migration probe.
          candidate.from("profiles").select("user_id").limit(1),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(new Error("probe timeout")), timeoutMs);
          }),
        ]);
        if (probe?.error || !Array.isArray(probe?.data)) fail("probe_failed");
        probing = false;
        client = candidate;
        state = "available";
        reason = null;
        hasServiceRoleKey = true;
      } catch {
        probing = false;
        fail("probe_failed");
      } finally {
        if (timer) clearTimeout(timer);
      }
    })().finally(() => {
      initializePromise = null;
    });
    return initializePromise;
  }

  async function requireCapability(): Promise<SupabaseClient> {
    await initialize();
    if (state !== "available" || !client) throw new AdminUnavailableError(reason ?? "probe_failed");
    return client;
  }

  function getSynchronousClient(): SupabaseClient {
    if (state !== "available" || !client) throw new AdminUnavailableError(reason ?? "probe_failed");
    return client;
  }

  return {
    initialize,
    requireCapability,
    getSynchronousClient,
    status: () => ({ state, available: state === "available", reason }),
  };
}

// Resolve URL — accept either VITE_SUPABASE_URL (Replit convention) or
// plain SUPABASE_URL so the server works regardless of which name is set.
const _urlSource =
  process.env.VITE_SUPABASE_URL ? "VITE_SUPABASE_URL"
  : process.env.SUPABASE_URL ? "SUPABASE_URL"
  : null;
const envUrl = _urlSource ? process.env[_urlSource] : undefined;

// The anon credential is deliberately separate and is never used as admin.
const _keySource =
  process.env.VITE_SUPABASE_ANON_KEY ? "VITE_SUPABASE_ANON_KEY"
  : process.env.SUPABASE_ANON_KEY ? "SUPABASE_ANON_KEY"
  : process.env.SUPABASE_PUBLISHABLE_KEY ? "SUPABASE_PUBLISHABLE_KEY"
  : null;
const envKey = _keySource ? process.env[_keySource] : undefined;

if (!envUrl) {
  throw new Error("Missing Supabase URL — set VITE_SUPABASE_URL or SUPABASE_URL");
}
if (!envKey) {
  throw new Error("Missing Supabase anon key — set VITE_SUPABASE_ANON_KEY, SUPABASE_ANON_KEY, or SUPABASE_PUBLISHABLE_KEY");
}

let supabaseUrl: string;
try {
  supabaseUrl = new URL(envUrl).origin;
} catch {
  throw new Error("Supabase URL is invalid");
}

export const supabase = createClient(supabaseUrl, envKey, { realtime: realtimeOpts });
export let hasServiceRoleKey = false;

const adminCapability = createAdminCapabilityManager({
  url: supabaseUrl,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
});

/** Start the bounded read-only verification. Calling repeatedly is safe. */
export function initializeSupabaseAdmin(): Promise<void> {
  return adminCapability.initialize();
}

/** Wait for a successful privileged probe; never returns the anon client. */
export function requireAdminCapability(): Promise<SupabaseClient> {
  return adminCapability.requireCapability();
}

/** Safe status for health checks; contains no URLs, keys, or probe errors. */
export function adminCapabilityStatus() {
  return adminCapability.status();
}

/**
 * Compatibility export for synchronous call sites. It is intentionally not an
 * anon fallback: access before a successful probe throws AdminUnavailableError.
 * New/guarded call sites should await requireAdminCapability().
 */
export const supabaseAdmin = new Proxy({} as SupabaseClient, {
  get(_target, property) {
    const resolved = adminCapability.getSynchronousClient();
    const value = Reflect.get(resolved, property, resolved);
    return typeof value === "function" ? value.bind(resolved) : value;
  },
});

export function createUserClient(authorizationHeader: string): SupabaseClient {
  return createClient(supabaseUrl, envKey!, {
    global: { headers: { Authorization: authorizationHeader } },
    realtime: realtimeOpts,
  });
}