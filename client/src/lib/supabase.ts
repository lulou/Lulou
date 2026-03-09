import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const rawKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const isValidJwt = (key: string | undefined): boolean =>
  !!key && key.startsWith("eyJ") && key.length > 100;

const supabaseAnonKey = isValidJwt(rawKey) ? rawKey : undefined;

console.log("[AUTH] SUPABASE_URL_PRESENT:", !!supabaseUrl, supabaseUrl ? `(${supabaseUrl.substring(0, 30)}...)` : "(missing)");
console.log("[AUTH] SUPABASE_KEY_PRESENT:", !!supabaseAnonKey, supabaseAnonKey ? `(length: ${supabaseAnonKey.length})` : "(missing or invalid)");
if (rawKey && !isValidJwt(rawKey)) {
  console.warn("[AUTH] VITE_SUPABASE_ANON_KEY is set but not a valid JWT (starts with:", rawKey.substring(0, 10) + "..., length:", rawKey.length + "). Check Replit Secrets.");
}

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("[AUTH] FATAL: Missing or invalid Supabase environment variables.");
  throw new Error("VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set to valid values");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
