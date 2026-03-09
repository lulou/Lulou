import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL_FALLBACK = "https://tizlwrcgdlvogbazrxef.supabase.co";
const SUPABASE_ANON_KEY_FALLBACK = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRpemx3cmNnZGx2b2diYXpyeGVmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI0MjI0MzMsImV4cCI6MjA4Nzk5ODQzM30.4M8hXUyS49epaYxwQPTX9lVIe3XLzuh25VNvwIIfK18";

const isValidJwt = (key: string | undefined): boolean =>
  !!key && key.startsWith("eyJ") && key.length > 100;

const envUrl = import.meta.env.VITE_SUPABASE_URL;
const envKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

const supabaseUrl = envUrl || SUPABASE_URL_FALLBACK;
const supabaseAnonKey = isValidJwt(envKey) ? envKey : SUPABASE_ANON_KEY_FALLBACK;

const urlSource = envUrl ? "env" : "fallback";
const keySource = isValidJwt(envKey) ? "env" : "fallback";

console.log("[AUTH] SUPABASE_URL_PRESENT:", true, `(${supabaseUrl.substring(0, 30)}..., source: ${urlSource})`);
console.log("[AUTH] SUPABASE_KEY_PRESENT:", true, `(length: ${supabaseAnonKey.length}, source: ${keySource})`);
if (envKey && !isValidJwt(envKey)) {
  console.warn("[AUTH] VITE_SUPABASE_ANON_KEY env var is not a valid JWT, using fallback. Update Replit Secrets with the correct key.");
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
