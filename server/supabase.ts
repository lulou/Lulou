import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL_FALLBACK = "https://tizlwrcgdlvogbazrxef.supabase.co";
const SUPABASE_ANON_KEY_FALLBACK = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpemx3cmNnZGx2b2diYXpyeGVmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0MjI0MzMsImV4cCI6MjA4Nzk5ODQzM30.4M8hXUyS49epaYxwQPTX9lVIe3XLzuh25VNvwIIfK18";

const isValidJwt = (key: string | undefined): boolean =>
  !!key && key.startsWith("eyJ") && key.length > 100;

const envUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const envKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

const supabaseUrl = envUrl || SUPABASE_URL_FALLBACK;
const supabaseAnonKey = isValidJwt(envKey) ? envKey! : SUPABASE_ANON_KEY_FALLBACK;

console.log("[SERVER_AUTH] SUPABASE_URL:", supabaseUrl.substring(0, 30) + "...");
console.log("[SERVER_AUTH] SUPABASE_KEY: length=" + supabaseAnonKey.length, "source=" + (isValidJwt(envKey) ? "env" : "fallback"));
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
