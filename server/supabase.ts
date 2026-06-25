import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import ws from "ws";

const isValidJwt = (key: string | undefined): boolean =>
  !!key && key.startsWith("eyJ") && key.length > 100;

// Resolve URL — accept either VITE_SUPABASE_URL (Replit convention) or
// plain SUPABASE_URL so the server works regardless of which name is set.
const _urlSource =
  process.env.VITE_SUPABASE_URL   ? "VITE_SUPABASE_URL"
  : process.env.SUPABASE_URL      ? "SUPABASE_URL"
  : null;
const envUrl = _urlSource ? process.env[_urlSource] : undefined;

// Resolve anon key — accept VITE_SUPABASE_ANON_KEY, SUPABASE_ANON_KEY, or
// SUPABASE_PUBLISHABLE_KEY (any of the common naming conventions).
const _keySource =
  process.env.VITE_SUPABASE_ANON_KEY  ? "VITE_SUPABASE_ANON_KEY"
  : process.env.SUPABASE_ANON_KEY     ? "SUPABASE_ANON_KEY"
  : process.env.SUPABASE_PUBLISHABLE_KEY ? "SUPABASE_PUBLISHABLE_KEY"
  : null;
const envKey = _keySource ? process.env[_keySource] : undefined;

const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!envUrl) {
  throw new Error(
    "Missing Supabase URL — set VITE_SUPABASE_URL or SUPABASE_URL in environment secrets"
  );
}
if (!envKey) {
  throw new Error(
    "Missing Supabase anon key — set VITE_SUPABASE_ANON_KEY, SUPABASE_ANON_KEY, or SUPABASE_PUBLISHABLE_KEY in environment secrets"
  );
}
if (!isValidJwt(envKey)) {
  console.warn(`[SERVER_AUTH] WARNING: ${_keySource} does not appear to be a valid JWT (length=${envKey.length}). Supabase calls may fail.`);
}

const supabaseUrl = envUrl;
const supabaseAnonKey = envKey;

console.log(`[SERVER_AUTH] SUPABASE_URL resolved from ${_urlSource}:`, supabaseUrl.substring(0, 30) + "...");
console.log(`[SERVER_AUTH] SUPABASE_KEY resolved from ${_keySource}: length=${supabaseAnonKey.length}`);
console.log("[SERVER_AUTH] SERVICE_ROLE_KEY:", serviceRoleKey ? `length=${serviceRoleKey.length}` : "NOT SET");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const realtimeOpts = { transport: ws as any };

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  realtime: realtimeOpts,
});

export const supabaseAdmin: SupabaseClient = isValidJwt(serviceRoleKey)
  ? createClient(supabaseUrl, serviceRoleKey!, {
      auth: { autoRefreshToken: false, persistSession: false },
      realtime: realtimeOpts,
    })
  : supabase;

export const hasServiceRoleKey = isValidJwt(serviceRoleKey);

export function createUserClient(authorizationHeader: string): SupabaseClient {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: { Authorization: authorizationHeader },
    },
    realtime: realtimeOpts,
  });
}
