import { createClient } from "@supabase/supabase-js";

const isValidJwt = (key: string | undefined): boolean =>
  !!key && key.startsWith("eyJ") && key.length > 100;

const envUrl = import.meta.env.VITE_SUPABASE_URL;
const envKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!envUrl) {
  throw new Error("Missing required environment variable: VITE_SUPABASE_URL");
}
if (!isValidJwt(envKey)) {
  throw new Error("Missing or invalid required environment variable: VITE_SUPABASE_ANON_KEY");
}

const supabaseUrl = envUrl;
const supabaseAnonKey = envKey;

console.log("[AUTH] SUPABASE_URL_PRESENT:", true, `(${supabaseUrl.substring(0, 30)}...)`);
console.log("[AUTH] SUPABASE_KEY_PRESENT:", true, `(length: ${supabaseAnonKey.length})`);

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    flowType: "implicit",
    storageKey: "sb-lulou-auth-token",
  },
});
