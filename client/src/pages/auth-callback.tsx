import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { supabase } from "@/lib/supabase";
import { Loader2, CheckCircle, AlertCircle } from "lucide-react";

// ── Auth Callback Page ─────────────────────────────────────────────────────
//
// Supabase email links (sign-up confirmation, password reset, email change)
// redirect to this page after the server verifies the token.
//
// Implicit / hash flow (flowType: "implicit") — the link lands on:
//   https://lulouapp.vercel.app/auth/callback#access_token=...&type=signup
//
// PKCE / code flow — the link lands on:
//   https://lulouapp.vercel.app/auth/callback?code=...
//
// With detectSessionInUrl:true the Supabase SDK automatically parses the hash
// and fires SIGNED_IN / PASSWORD_RECOVERY on this page.  We listen for the
// event, show a loading state, and redirect to / once the session is live.
// ──────────────────────────────────────────────────────────────────────────

type Status = "loading" | "success" | "error";

export default function AuthCallbackPage() {
  const [, setLocation] = useLocation();
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let done = false;

    function succeed() {
      if (done) return;
      done = true;
      setStatus("success");
      // Clean the hash/code params from the URL bar for security
      window.history.replaceState(null, "", window.location.pathname);
      // Short pause so the user sees the success tick, then redirect to root.
      // use-auth.ts will have set user state by the time / renders.
      setTimeout(() => setLocation("/"), 1200);
    }

    function fail(msg: string) {
      if (done) return;
      done = true;
      setStatus("error");
      setErrorMsg(msg);
      console.error("[AUTH_CALLBACK] verification failed:", msg);
    }

    // ── 1. Check for error params Supabase appends for invalid/expired links ─
    const urlParams = new URLSearchParams(window.location.search);
    const errorCode = urlParams.get("error");
    const errorDesc = urlParams.get("error_description");
    if (errorCode) {
      fail((errorDesc ?? errorCode).replace(/\+/g, " "));
      return;
    }

    // ── 2. PKCE code flow: ?code=... ─────────────────────────────────────────
    const code = urlParams.get("code");
    if (code) {
      supabase.auth
        .exchangeCodeForSession(code)
        .then(({ error }) => {
          if (error) fail(error.message);
          // On success onAuthStateChange fires SIGNED_IN below → succeed()
        })
        .catch((err: unknown) =>
          fail((err instanceof Error ? err.message : null) ?? "Verification failed"),
        );
    }

    // ── 3. Implicit / hash flow: #access_token=... ───────────────────────────
    // detectSessionInUrl:true means the SDK may have already parsed the hash
    // and stored the session before this useEffect runs.  Check immediately.
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) succeed();
    });

    // ── 4. Listen for auth events (covers hash processed after mount) ─────────
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      console.log("[AUTH_CALLBACK] auth event:", event);
      if (
        event === "SIGNED_IN" ||
        event === "USER_UPDATED" ||
        event === "PASSWORD_RECOVERY"
      ) {
        succeed();
      }
    });

    // ── 5. Hard timeout ───────────────────────────────────────────────────────
    const timeout = setTimeout(() => {
      fail(
        "This verification link has expired or is invalid. " +
        "Please return to the app and request a new one.",
      );
    }, 15_000);

    return () => {
      subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, [setLocation]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-5">
      <div className="w-full max-w-sm space-y-5 text-center">
        {status === "loading" && (
          <>
            <div className="flex justify-center">
              <div className="relative">
                <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                  <Loader2 className="w-8 h-8 text-primary animate-spin" />
                </div>
              </div>
            </div>
            <div className="space-y-1.5">
              <h1 className="font-display text-2xl font-semibold tracking-tight">
                Verifying your email…
              </h1>
              <p className="text-sm text-muted-foreground">
                Just a moment while we confirm your account.
              </p>
            </div>
          </>
        )}

        {status === "success" && (
          <>
            <div className="flex justify-center">
              <div className="w-16 h-16 rounded-full bg-green-50 border border-green-100 flex items-center justify-center">
                <CheckCircle className="w-8 h-8 text-green-500" />
              </div>
            </div>
            <div className="space-y-1.5">
              <h1 className="font-display text-2xl font-semibold tracking-tight">
                Email verified!
              </h1>
              <p className="text-sm text-muted-foreground">
                Taking you into Lulou…
              </p>
            </div>
            <div className="flex justify-center">
              <Loader2 className="w-4 h-4 text-muted-foreground animate-spin" />
            </div>
          </>
        )}

        {status === "error" && (
          <>
            <div className="flex justify-center">
              <div className="w-16 h-16 rounded-full bg-destructive/10 border border-destructive/20 flex items-center justify-center">
                <AlertCircle className="w-8 h-8 text-destructive" />
              </div>
            </div>
            <div className="space-y-1.5">
              <h1 className="font-display text-2xl font-semibold tracking-tight">
                Verification failed
              </h1>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {errorMsg ??
                  "This link has expired or is invalid. Please request a new verification email."}
              </p>
            </div>
            <button
              onClick={() => setLocation("/")}
              className="w-full py-2.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
              data-testid="button-return-to-signin"
            >
              Return to sign in
            </button>
          </>
        )}
      </div>
    </div>
  );
}
