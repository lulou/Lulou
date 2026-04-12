import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const isValidJwt = (key: string | undefined): boolean =>
  !!key && key.startsWith("eyJ") && key.length > 100;

const envUrl = process.env.VITE_SUPABASE_URL;
const envKey = process.env.VITE_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!envUrl) {
  throw new Error("Missing required environment variable: VITE_SUPABASE_URL");
}
if (!envKey) {
  throw new Error("Missing required environment variable: VITE_SUPABASE_ANON_KEY");
}
if (!isValidJwt(envKey)) {
  console.warn("[SERVER_AUTH] WARNING: VITE_SUPABASE_ANON_KEY does not appear to be a valid JWT (length=" + envKey.length + "). Supabase calls may fail.");
}

const supabaseUrl = envUrl;
const supabaseAnonKey = envKey;

console.log("[SERVER_AUTH] SUPABASE_URL:", supabaseUrl.substring(0, 30) + "...");
console.log("[SERVER_AUTH] SUPABASE_KEY: length=" + supabaseAnonKey.length);
console.log("[SERVER_AUTH] SERVICE_ROLE_KEY:", serviceRoleKey ? `length=${serviceRoleKey.length}` : "NOT SET");

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export const supabaseAdmin: SupabaseClient = isValidJwt(serviceRoleKey)
  ? createClient(supabaseUrl, serviceRoleKey!, { auth: { autoRefreshToken: false, persistSession: false } })
  : supabase;

export const hasServiceRoleKey = isValidJwt(serviceRoleKey);

export function createUserClient(authorizationHeader: string): SupabaseClient {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: {
      headers: { Authorization: authorizationHeader },
    },
  });
}
