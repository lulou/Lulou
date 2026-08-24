import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { supabase } from "@/lib/supabase";
import { LulouFlowerIcon } from "@/components/app-layout";
import { Loader2, CheckCircle, AlertCircle, Mail } from "lucide-react";
import type { Session } from "@supabase/supabase-js";

// ── Auth Callback Page ─────────────────────────────────────────────────────
//
// Supabase email links (sign-up confirmation, password reset, magic-link)
// redirect to this page after the server verifies the token.
//
// Implicit / hash flow (flowType:"implicit") — link lands on:
//   https://lulouapp.vercel.app/auth/callback#access_token=...&type=signup
//
// PKCE / code flow — link lands on:
//   https://lulouapp.vercel.app/auth/callback?code=...
//
// With detectSessionInUrl:true the Supabase SDK automatically parses the
// hash and fires SIGNED_IN / PASSWORD_RECOVERY / INITIAL_SESSION(session)
// on this page.  We listen for the event, show a loading state, then
// redirect to / once the session is live.
//
// Link types in the hash `type` param:
//   "signup"    — email verification link (new account confirmation)
//   "recovery"  — password reset link
//   "magiclink" — passwordless sign-in link
//   "email"     — email change confirmation
//
// use-auth.ts sets isLoading:true when SIGNED_IN fires (before the async
// session-check IIFE), so navigating to / shows the auth spinner — not the
// Landing page — while the session-check runs.
// ──────────────────────────────────────────────────────────────────────────

type Status = "loading" | "success" | "error";

// Link type from the hash `type` param.
type LinkType = "signup" | "recovery" | "magiclink" | "email" | "unknown";

const CB_TAG = "[AUTH_CALLBACK]";
const VERIFY_TAG = "[VERIFY]";
const t0 = Date.now();
function ms() { return `+${Date.now() - t0}ms`; }

export default function AuthCallbackPage() {
  const [, setLocation] = useLocation();
  const [status, setStatus]       = useState<Status>("loading");
  const [errorMsg, setErrorMsg]   = useState<string | null>(null);
  const [linkType, setLinkType]   = useState<LinkType>("unknown");
  const [confirmedAt, setConfirmedAt] = useState<string | null>(null);

  useEffect(() => {
    let done = false;

    // ── 0. Entry diagnostics ─────────────────────────────────────────────────
    const fullUrl   = window.location.href;
    const hash      = window.location.hash;
    const search    = window.location.search;
    const urlParams = new URLSearchParams(search);
    const hashParams = hash ? new URLSearchParams(hash.slice(1)) : new URLSearchParams();

    // Parse the link type from the hash (implicit flow) or query (PKCE flow).
    const rawType = (hashParams.get("type") ?? urlParams.get("type") ?? "unknown") as LinkType;
    setLinkType(rawType);

    const isSignupVerification = rawType === "signup" || rawType === "email";

    console.log(`${CB_TAG} ENTRY`, {
      elapsed:   ms(),
      pathname:  window.location.pathname,
      linkType:  rawType,
      hasHash:   !!hash,
      hashKeys:  hash ? [...hashParams.keys()] : [],
      hasSearch: !!search,
      searchKeys: search ? [...urlParams.keys()] : [],
      urlPreview: fullUrl.slice(0, 80) + (fullUrl.length > 80 ? "…" : ""),
    });

    if (isSignupVerification) {
      console.log(`${VERIFY_TAG} LINK_CLICKED — verification link opened in browser`, {
        elapsed: ms(),
        linkType: rawType,
      });
    }

    // ── Helpers ──────────────────────────────────────────────────────────────

    function succeed(reason: string, session?: Session | null) {
      if (done) return;
      done = true;

      // Explicitly log whether email_confirmed_at is set in the session.
      // This is the definitive proof that Supabase has confirmed the email.
      const emailConfirmedAt = session?.user?.email_confirmed_at ?? null;
      setConfirmedAt(emailConfirmedAt);

      if (isSignupVerification) {
        if (emailConfirmedAt) {
          console.log(
            `${VERIFY_TAG} USER_CONFIRMED ✓ — email_confirmed_at is set in session`,
            { elapsed: ms(), email_confirmed_at: emailConfirmedAt, userId: session?.user?.id?.slice(0, 8) }
          );
        } else {
          // email_confirmed_at may be absent if the SDK hasn't yet refreshed the user
          // object — this is benign; the server's admin API will see the updated value.
          console.warn(
            `${VERIFY_TAG} USER_CONFIRMED (email_confirmed_at not yet in session JWT — server will re-check via admin API)`,
            { elapsed: ms(), reason }
          );
        }
      }

      console.log(`${CB_TAG} ✓ SUCCEED`, { reason, elapsed: ms(), linkType: rawType, emailConfirmedAt });
      setStatus("success");

      // Clean the hash / code param from the URL bar for security.
      window.history.replaceState(null, "", window.location.pathname);

      // Pause long enough for the user to read the success message, then
      // hand off to AppContent.  use-auth.ts has already set isLoading:true
      // (SIGNED_IN handler), so AppContent shows its own spinner — not Landing
      // — while the async session-check IIFE finishes.
      const redirectDelay = isSignupVerification ? 1500 : 1000;
      setTimeout(() => {
        console.log(`${CB_TAG} → navigating to /`, { elapsed: ms() });
        setLocation("/");
      }, redirectDelay);
    }

    function fail(msg: string, reason?: string) {
      if (done) return;
      done = true;
      console.error(`${CB_TAG} ✗ FAIL`, { reason: reason ?? msg, elapsed: ms(), linkType: rawType });
      if (isSignupVerification) {
        console.error(`${VERIFY_TAG} VERIFICATION_FAILED`, { reason: reason ?? msg, elapsed: ms() });
      }
      setStatus("error");
      setErrorMsg(msg);
    }

    // ── 1. Supabase error params (?error=... appended for invalid links) ──────
    const errorCode = urlParams.get("error");
    const errorDesc = urlParams.get("error_description");
    if (errorCode) {
      const msg = (errorDesc ?? errorCode).replace(/\+/g, " ");
      console.error(`${CB_TAG} URL error param detected`, { errorCode, errorDesc: msg });
      fail(msg, "url_error_param");
      return;
    }

    // ── 2. PKCE code flow: ?code=... ─────────────────────────────────────────
    // flowType:"implicit" should produce hash tokens, but handle ?code= too in
    // case the Supabase project is configured for PKCE at the server level.
    const code = urlParams.get("code");
    if (code) {
      console.log(`${CB_TAG} PKCE code detected — calling exchangeCodeForSession`, { elapsed: ms() });
      supabase.auth
        .exchangeCodeForSession(code)
        .then(({ data: { session }, error }) => {
          console.log(`${CB_TAG} exchangeCodeForSession result`, {
            elapsed:        ms(),
            hasSession:     !!session,
            userId:         session?.user?.id?.slice(0, 8) ?? null,
            emailConfirmedAt: session?.user?.email_confirmed_at ?? null,
            error:          error?.message ?? null,
          });
          if (error) {
            fail(error.message, "pkce_exchange_error");
          } else if (session && !done) {
            succeed("pkce_exchange_success", session);
          }
          // Otherwise onAuthStateChange fires SIGNED_IN → succeed() below
        })
        .catch((err: unknown) => {
          const msg = (err instanceof Error ? err.message : null) ?? "Code exchange failed";
          fail(msg, "pkce_exchange_throw");
        });
    }

    // ── 3. Implicit hash flow — getSession() ─────────────────────────────────
    // detectSessionInUrl:true means the SDK may have already parsed the
    // #access_token hash and stored the session before this useEffect runs.
    // Check immediately — this covers the fast-init case.
    console.log(`${CB_TAG} calling getSession() to check for hash-processed session`, { elapsed: ms() });
    supabase.auth.getSession().then(({ data: { session }, error }) => {
      console.log(`${CB_TAG} getSession() result`, {
        elapsed:         ms(),
        hasSession:      !!session,
        userId:          session?.user?.id?.slice(0, 8) ?? null,
        emailConfirmedAt: session?.user?.email_confirmed_at ?? null,
        error:           error?.message ?? null,
      });
      if (session && !done) {
        succeed("getSession_found_session", session);
      }
    });

    // ── 4. onAuthStateChange — covers events fired after mount ────────────────
    // The SDK immediately fires INITIAL_SESSION to a new subscriber with the
    // current auth state.  If the hash was already processed (fast-init path),
    // INITIAL_SESSION fires with the session → we must handle it here.
    // SIGNED_IN fires when the SDK processes the hash after mount (slow path).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      console.log(`${CB_TAG} onAuthStateChange`, {
        elapsed:         ms(),
        event,
        hasSession:      !!session,
        userId:          session?.user?.id?.slice(0, 8) ?? null,
        emailConfirmedAt: session?.user?.email_confirmed_at ?? null,
        done,
      });

      if (done) {
        console.log(`${CB_TAG} already done — ignoring event`, { event });
        return;
      }

      switch (event) {
        case "SIGNED_IN":
        case "USER_UPDATED":
          succeed(event.toLowerCase(), session);
          break;

        case "PASSWORD_RECOVERY":
          // For password reset, the main app's PasswordRecoveryGate handles
          // the UI.  Just redirect to / — use-auth.ts already set
          // passwordRecovery:true so AppContent will show the gate.
          console.log(`${CB_TAG} PASSWORD_RECOVERY — redirecting to gate`, { elapsed: ms() });
          succeed("password_recovery", session);
          break;

        case "INITIAL_SESSION":
          // The SDK fires INITIAL_SESSION immediately to every new subscriber
          // with the current session state.  If session is non-null, the hash
          // has already been parsed — treat it the same as SIGNED_IN.
          if (session) {
            console.log(`${CB_TAG} INITIAL_SESSION with live session — treating as sign-in`, { elapsed: ms() });
            succeed("initial_session_with_session", session);
          } else {
            console.log(`${CB_TAG} INITIAL_SESSION with null session — waiting for SIGNED_IN`, { elapsed: ms() });
          }
          break;

        default:
          console.log(`${CB_TAG} unhandled event (no action)`, { event });
      }
    });

    // ── 5. Hard timeout ───────────────────────────────────────────────────────
    const timeout = setTimeout(() => {
      console.error(`${CB_TAG} TIMEOUT — 15s elapsed without session`, {
        elapsed: ms(),
        url:     window.location.href.slice(0, 80),
      });
      fail(
        "Verification timed out — the link may have expired. Please return to the app and request a new one.",
        "timeout",
      );
    }, 15_000);

    return () => {
      console.log(`${CB_TAG} cleanup`, { elapsed: ms(), done });
      subscription.unsubscribe();
      clearTimeout(timeout);
    };
  }, [setLocation]);

  // ── Messaging by link type ─────────────────────────────────────────────────
  const isSignup   = linkType === "signup" || linkType === "email";
  const isRecovery = linkType === "recovery";

  const loadingTitle = isSignup ? "Verifying your email…" : isRecovery ? "Confirming reset link…" : "Signing you in…";
  const loadingBody  = isSignup ? "Just a moment while we confirm your account." : "Just a moment…";

  const successTitle = isSignup ? "Email verified!" : isRecovery ? "Reset link confirmed" : "Signed in";
  const successBody  = isSignup
    ? (confirmedAt
        ? "Your email is confirmed. Taking you into Lulou…"
        : "Account confirmed. Taking you into Lulou…")
    : "Taking you into Lulou…";

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div
      className="min-h-[100dvh] flex items-center justify-center bg-background px-5"
      style={{
        paddingInlineStart: "max(1.25rem, env(safe-area-inset-left, 0px))",
        paddingInlineEnd: "max(1.25rem, env(safe-area-inset-right, 0px))",
        paddingTop: "max(1.25rem, env(safe-area-inset-top, 0px))",
        paddingBottom: "max(1.25rem, env(safe-area-inset-bottom, 0px))",
      }}
    >
      <div className="w-full max-w-sm space-y-5 text-center">

        {status === "loading" && (
          <>
            <div className="flex justify-center">
              <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-primary animate-spin" />
              </div>
            </div>
            <div className="space-y-1.5">
              <h1 className="font-display text-2xl font-semibold tracking-tight">
                {loadingTitle}
              </h1>
              <p className="text-sm text-muted-foreground">
                {loadingBody}
              </p>
            </div>
          </>
        )}

        {status === "success" && isSignup && (
          <>
            <style>{`
              @keyframes lulouGlowPulse {
                0%, 100% { opacity: 0.55; transform: translate(-50%, -50%) scale(1); }
                50%       { opacity: 1;    transform: translate(-50%, -50%) scale(1.10); }
              }
              @keyframes lulouLogoIn {
                from { opacity: 0; transform: scale(0.72); }
                to   { opacity: 1; transform: scale(1); }
              }
              @keyframes lulouTextIn {
                from { opacity: 0; transform: translateY(12px); }
                to   { opacity: 1; transform: translateY(0); }
              }
            `}</style>

            {/* ── Logo with layered rose glow ── */}
            <div className="relative flex justify-center" style={{ height: 100 }}>
              <div style={{
                position: "absolute", width: 180, height: 180,
                borderRadius: "50%",
                background: "radial-gradient(circle, hsl(350 45% 52% / 0.16) 0%, transparent 68%)",
                top: "50%", left: "50%",
                animation: "lulouGlowPulse 2.6s ease-in-out infinite",
                pointerEvents: "none",
              }} />
              <div style={{
                position: "absolute", width: 110, height: 110,
                borderRadius: "50%",
                background: "radial-gradient(circle, hsl(350 45% 52% / 0.22) 0%, transparent 70%)",
                top: "50%", left: "50%",
                animation: "lulouGlowPulse 2.6s ease-in-out infinite 1.0s",
                pointerEvents: "none",
              }} />
              <div
                className="absolute top-1/2 left-1/2 w-[84px] h-[84px] rounded-full flex items-center justify-center"
                style={{
                  transform: "translate(-50%, -50%)",
                  background: "linear-gradient(135deg, hsl(350 45% 52% / 0.14) 0%, hsl(350 45% 52% / 0.06) 100%)",
                  boxShadow: "0 0 0 1.5px hsl(350 45% 52% / 0.22), 0 8px 32px hsl(350 45% 52% / 0.18)",
                  animation: "lulouLogoIn 0.65s cubic-bezier(0.16, 1, 0.3, 1) both",
                }}
              >
                <LulouFlowerIcon className="w-11 h-11" />
              </div>
            </div>

            {/* ── Text ── */}
            <div className="space-y-3" style={{ animation: "lulouTextIn 0.55s 0.35s ease both" }}>
              <p className="text-[10px] font-bold tracking-[0.26em] uppercase text-primary">
                Welcome to Lulou
              </p>
              <h1 className="font-serif text-3xl font-bold tracking-tight leading-snug">
                Your email has<br />been verified.
              </h1>
              <p className="text-sm text-muted-foreground">
                Preparing your profile…
              </p>
            </div>

            <div className="flex justify-center mt-2" style={{ animation: "lulouTextIn 0.5s 0.7s ease both" }}>
              <Loader2 className="w-4 h-4 text-primary/30 animate-spin" />
            </div>
          </>
        )}

        {status === "success" && !isSignup && (
          <>
            <div className="flex justify-center">
              <div className="w-16 h-16 rounded-full bg-green-50 border border-green-100 flex items-center justify-center">
                <Mail className="w-8 h-8 text-green-500" />
              </div>
            </div>
            <div className="space-y-1.5">
              <h1 className="font-serif text-2xl font-bold tracking-tight">
                {successTitle}
              </h1>
              <p className="text-sm text-muted-foreground">
                {successBody}
              </p>
            </div>
            <div className="flex justify-center">
              <Loader2 className="w-4 h-4 text-muted-foreground/50 animate-spin" />
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
                {isSignup ? "Verification failed" : "Link invalid"}
              </h1>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {errorMsg ??
                  "This link has expired or is invalid. Please return to the app and request a new one."}
              </p>
            </div>
            <div className="flex flex-col gap-2">
              <button
                onClick={() => {
                  console.log(`${CB_TAG} user clicked Return to sign in`);
                  setLocation("/");
                }}
                className="min-h-11 w-full rounded-lg bg-primary px-4 py-2.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
                data-testid="button-return-to-signin"
              >
                Return to sign in
              </button>
              {isSignup && (
                <p className="text-xs text-muted-foreground">
                  Once signed in you can request a new verification email.
                </p>
              )}
            </div>
          </>
        )}

      </div>
    </div>
  );
}
