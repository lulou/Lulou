import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

console.log("[AUTH] SUPABASE_URL_PRESENT:", !!supabaseUrl, supabaseUrl ? `(${supabaseUrl.substring(0, 30)}...)` : "(missing)");
console.log("[AUTH] SUPABASE_KEY_PRESENT:", !!supabaseAnonKey, supabaseAnonKey ? `(length: ${supabaseAnonKey.length})` : "(missing)");

if (!supabaseUrl || !supabaseAnonKey) {
  console.error("[AUTH] FATAL: Missing Supabase environment variables. VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set.");
  throw new Error("VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY must be set");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
