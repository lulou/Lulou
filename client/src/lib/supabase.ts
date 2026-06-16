import { createClient } from "@supabase/supabase-js";

const isValidJwt = (key: string | undefined): boolean =>
  !!key && key.startsWith("eyJ") && key.length > 100;

const envUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const envKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// ── Diagnostics — dev only ────────────────────────────────────────────────────
if (import.meta.env.DEV) {
  console.log("ALL VITE ENV KEYS", Object.keys(import.meta.env).filter(k => k.startsWith("VITE")));
  console.log("RAW VITE_SUPABASE_URL", import.meta.env.VITE_SUPABASE_URL);
  console.log("RAW VITE_SUPABASE_ANON_KEY length", import.meta.env.VITE_SUPABASE_ANON_KEY?.length ?? "undefined");
}

if (!envUrl) {
  console.warn(
    "[AUTH] WARNING: VITE_SUPABASE_URL is missing. " +
    "Add it to Vercel Environment Variables (Settings → Environment Variables) " +
    "then redeploy so Vite can bake it into the bundle. " +
    "App will render but auth and all API calls will fail."
  );
}
if (!envKey) {
  console.warn(
    "[AUTH] WARNING: VITE_SUPABASE_ANON_KEY is missing. " +
    "Add it to Vercel Environment Variables (Settings → Environment Variables) " +
    "then redeploy so Vite can bake it into the bundle. " +
    "App will render but auth and all API calls will fail."
  );
}
if (envKey && !isValidJwt(envKey)) {
  console.warn("[AUTH] WARNING: VITE_SUPABASE_ANON_KEY does not appear to be a valid JWT (length=" + envKey.length + "). Auth may not work correctly.");
}

if (!envUrl || !envKey) {
  console.error("[AUTH] FATAL: Supabase env vars missing — VITE_SUPABASE_URL present:", !!envUrl, "| VITE_SUPABASE_ANON_KEY present:", !!envKey);
}

const supabaseUrl = envUrl as string;
const supabaseAnonKey = envKey as string;

if (import.meta.env.DEV) {
  console.log("[AUTH] SUPABASE_URL_PRESENT:", !!envUrl, envUrl ? `(${envUrl.substring(0, 30)}...)` : "(MISSING)");
  console.log("[AUTH] SUPABASE_KEY_PRESENT:", !!envKey, envKey ? `(length: ${envKey.length})` : "(MISSING)");
}

// ── Auth fetch debug ─────────────────────────────────────────────────────────
// Written by safeFetch on every /auth/v1/ call. Reset at the start of each
// handleSubmit so the panel always shows the most recent attempt's values.
export interface AuthFetchDebug {
  authFetchStarted:        boolean;       // true once safeFetch begins the real fetch()
  authFetchCallCount:      number;        // increments each time safeFetch is called for /auth/v1/
  authResponseStatus:      number | null;
  authResponseContentType: string | null;
  authParseMode:           "json" | "text" | null;
  authReturnedHtml:        boolean;
  authUserFacingError:     string | null;
}

export let lastAuthFetchDebug: AuthFetchDebug = {
  authFetchStarted:        false,
  authFetchCallCount:      0,
  authResponseStatus:      null,
  authResponseContentType: null,
  authParseMode:           null,
  authReturnedHtml:        false,
  authUserFacingError:     null,
};

export function resetAuthFetchDebug(): void {
  lastAuthFetchDebug = {
    authFetchStarted:        false,
    authFetchCallCount:      0,
    authResponseStatus:      null,
    authResponseContentType: null,
    authParseMode:           null,
    authReturnedHtml:        false,
    authUserFacingError:     null,
  };
}

// Exported so landing.tsx can read the config used by the client.
export const SUPABASE_URL      = supabaseUrl;
export const SUPABASE_KEY_LEN  = supabaseAnonKey.length;
export const AUTH_ENDPOINT     = `${supabaseUrl}/auth/v1/token?grant_type=password`;

// ── safeFetch ─────────────────────────────────────────────────────────────────
// Passed to createClient as global.fetch so it intercepts every HTTP call the
// Supabase SDK makes. For /auth/v1/ requests it checks content-type BEFORE the
// SDK calls response.json(). If the server returned an HTML error page (e.g. a
// Cloudflare 522 during an outage), the SDK would throw:
//   "Failed to create user: unexpected token '<', "<!DOCTYPE"... is not valid JSON"
// We prevent that by:
//   1. Reading the body as text (safe — we control the body consumption)
//   2. Detecting HTML by content-type or by the first bytes of the body
//   3. Returning a synthetic JSON response the SDK CAN parse, whose error code
//      "html_response_outage" is then caught by classifyAuthError in landing.tsx
// Non-auth requests pass through completely untouched.
async function safeFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
      ? input.href
      : (input as Request).url;

  // Pass non-auth requests straight through — no body consumption, no overhead.
  const isAuthRequest = url.includes("/auth/v1/");
  if (!isAuthRequest) {
    return fetch(input, init);
  }

  // Mark that an auth fetch was attempted.
  lastAuthFetchDebug.authFetchStarted   = true;
  lastAuthFetchDebug.authFetchCallCount += 1;

  const response = await fetch(input, init);

  const contentType = response.headers.get("content-type") ?? "";
  const status      = response.status;

  lastAuthFetchDebug.authResponseStatus      = status;
  lastAuthFetchDebug.authResponseContentType = contentType || "(none)";

  // If the response is already JSON, let the SDK handle it normally.
  // We return the original Response without touching the body.
  if (contentType.includes("application/json")) {
    lastAuthFetchDebug.authParseMode    = "json";
    lastAuthFetchDebug.authReturnedHtml = false;
    return response;
  }

  // ── Non-JSON body: read as text, check for HTML ───────────────────────────
  // This is the ONLY place the body is consumed. We own the body from here.
  lastAuthFetchDebug.authParseMode = "text";
  let bodyText = "";
  try {
    bodyText = await response.text();
  } catch {
    bodyText = "";
  }
  const trimmed  = bodyText.trimStart().toLowerCase();
  const isHtml   = trimmed.startsWith("<!doctype") || trimmed.startsWith("<html");
  lastAuthFetchDebug.authReturnedHtml    = isHtml;
  lastAuthFetchDebug.authUserFacingError =
    "Lulou is having trouble reaching the login service right now. Please try again shortly.";

  console.error(
    "[AUTH] SAFE_FETCH: non-JSON response from auth server",
    { url, status, contentType, isHtml, bodyPreview: bodyText.slice(0, 120) },
  );

  // Return a synthetic JSON error the SDK can parse cleanly.
  // The code "html_response_outage" is detected by classifyAuthError in landing.tsx
  // and mapped to kind:"network" with the friendly outage message.
  const syntheticBody = JSON.stringify({
    error_description: "html-response-outage",
    code:              "html_response_outage",
    message:           "html-response-outage",
    msg:               "html-response-outage",
  });

  return new Response(syntheticBody, {
    status:  status >= 400 ? status : 502,
    headers: { "content-type": "application/json" },
  });
}

// Derive the storage key from the project ref in the URL so it automatically
// changes when VITE_SUPABASE_URL is pointed at a different project.
// e.g. https://abcxyz.supabase.co → "sb-abcxyz-auth-token"
// If the URL is malformed the fallback keeps behaviour identical to before.
const _projectRef = (() => {
  try { return new URL(supabaseUrl).hostname.split(".")[0]; }
  catch { return "lulou"; }
})();
const _storageKey = `sb-${_projectRef}-auth-token`;

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession:      true,
    autoRefreshToken:    true,
    detectSessionInUrl:  false,
    flowType:            "implicit",
    storageKey:          _storageKey,   // derived from VITE_SUPABASE_URL, not hardcoded
  },
  global: {
    // safeFetch intercepts /auth/v1/ responses to prevent the SDK from
    // throwing a SyntaxError when the server returns an HTML error page.
    fetch: safeFetch,
  },
});
