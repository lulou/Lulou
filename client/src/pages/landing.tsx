import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Heart, MessageCircle, Phone, Shield, RefreshCw, Loader2, Lock, Eye, EyeOff, AlertCircle, WifiOff, CheckCircle } from "lucide-react";
import { LulouFlowerIcon } from "@/components/app-layout";
import { supabase } from "@/lib/supabase";
import { useToast } from "@/hooks/use-toast";

type AuthMode = "signin" | "signup";
type AuthErrorKind = "credentials" | "already-exists" | "network" | "auth";

interface AuthError {
  kind: AuthErrorKind;
  message: string;
}

function isAlreadyExists(err: any): boolean {
  const msg: string = (err?.message || "").toLowerCase();
  return (
    msg.includes("user already registered") ||
    msg.includes("already registered") ||
    msg.includes("already been registered") ||
    msg.includes("email address is already taken") ||
    msg.includes("already exists") ||
    err?.status === 422
  );
}

function classifyAuthError(err: any, mode: AuthMode): AuthError {
  // Supabase sometimes returns {} or a raw JSON string as the error body.
  // Unwrap it to extract a human-readable message before classifying.
  let raw: string = err?.message ?? "";
  if (!raw || raw === "{}" || (raw.startsWith("{") && raw.endsWith("}"))) {
    try {
      const parsed = JSON.parse(raw);
      raw =
        parsed?.error_description ||
        parsed?.message ||
        parsed?.msg ||
        parsed?.error ||
        "";
    } catch { /* raw stays as-is */ }
  }
  const msg: string = raw || "Something went wrong. Please try again.";
  const lower = msg.toLowerCase();
  if (mode === "signup" && isAlreadyExists(err)) {
    return { kind: "already-exists", message: msg };
  }
  if (
    lower.includes("invalid login credentials") ||
    lower.includes("invalid_grant") ||
    lower.includes("email not confirmed") ||
    lower.includes("user not found") ||
    lower.includes("wrong password")
  ) {
    return { kind: "credentials", message: msg };
  }
  if (
    err instanceof TypeError ||
    lower.includes("network") ||
    lower.includes("fetch") ||
    lower.includes("failed to fetch") ||
    lower.includes("load failed") ||       // Safari equivalent of "Failed to fetch"
    lower.includes("networkerror") ||
    lower.includes("connection") ||
    lower.includes("abort") ||
    lower.includes("timeout") ||
    lower.includes("timed out")
  ) {
    // Give users a concrete action rather than the raw browser error string.
    const detail = msg === "Load failed" || msg === "Failed to fetch"
      ? "Could not reach Lulou's servers. Check your internet connection and try again."
      : `Could not connect: ${msg}`;
    return { kind: "network", message: detail };
  }
  return { kind: "auth", message: msg };
}

export default function Landing() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState<AuthMode>("signin");
  const [authError, setAuthError] = useState<AuthError | null>(null);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetSent, setResetSent] = useState(false);
  const { toast } = useToast();

  function resetForm() {
    setEmail("");
    setPassword("");
    setMode("signin");
    setShowPassword(false);
    setAuthError(null);
    setResetSent(false);
  }

  function clearError() {
    if (authError) setAuthError(null);
    setResetSent(false);
  }

  function switchToSignIn() {
    setMode("signin");
    setAuthError(null);
    setPassword("");
    setResetSent(false);
  }

  async function handlePasswordReset() {
    if (!email.trim()) return;
    setResetLoading(true);
    try {
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim());
      if (error) {
        console.error("[AUTH] RESET_PASSWORD_FAILED", error.message);
        toast({ title: "Reset failed", description: error.message, variant: "destructive" });
      } else {
        setResetSent(true);
        setAuthError(null);
      }
    } catch (err: any) {
      console.error("[AUTH] RESET_PASSWORD_ERROR", err?.message);
      toast({ title: "Reset failed", description: err?.message || "Try again.", variant: "destructive" });
    } finally {
      setResetLoading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();

    // Show explicit errors for empty fields rather than silently blocking.
    if (!email.trim()) {
      console.warn("[AUTH] SUBMIT_BLOCKED: email empty");
      setAuthError({ kind: "auth", message: "Please enter your email address." });
      return;
    }
    if (!password) {
      console.warn("[AUTH] SUBMIT_BLOCKED: password empty");
      setAuthError({ kind: "auth", message: "Please enter your password." });
      return;
    }

    setAuthError(null);
    setResetSent(false);
    setLoading(true);
    console.log("[AUTH] AUTH_REQUEST_STARTED", { mode, email: email.trim() });

    try {
      if (mode === "signup") {
        const { data, error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
        });
        setLoading(false);
        if (error) {
          console.error("[AUTH] AUTH_REQUEST_FAILED", { mode, errorMessage: error.message, errorStatus: error.status });
          const classified = classifyAuthError(error, mode);
          if (classified.kind === "already-exists") {
            // Auto-switch to sign-in so the user can log in immediately
            setMode("signin");
            setPassword("");
          }
          setAuthError(classified);
          return;
        }
        console.log("[AUTH] AUTH_REQUEST_SUCCESS", { mode, userId: data.user?.id });
        toast({ title: "Account created", description: "You're now signed in." });
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        });
        setLoading(false);
        if (error) {
          console.error("[AUTH] AUTH_REQUEST_FAILED", { mode, errorMessage: error.message, errorStatus: error.status });
          setAuthError(classifyAuthError(error, mode));
          return;
        }
        console.log("[AUTH] AUTH_REQUEST_SUCCESS", { mode, userId: data.user?.id });
      }
    } catch (err: any) {
      setLoading(false);
      const msg = err?.message || "Unknown error";
      console.error("[AUTH] AUTH_ERROR_MESSAGE", { mode, error: msg, stack: err?.stack });
      setAuthError(classifyAuthError(err, mode));
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <nav className="fixed top-0 left-0 right-0 z-50 backdrop-blur-md bg-background/80 border-b">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <LulouFlowerIcon className="w-6 h-6 text-primary" />
            <span className="font-serif text-xl font-semibold tracking-tight" data-testid="text-logo">Lulou</span>
          </div>
          <button
            onClick={resetForm}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-primary transition-colors"
            data-testid="link-switch-account"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Switch Account
          </button>
        </div>
      </nav>

      <section className="relative pt-32 pb-20 px-6 overflow-hidden">
        <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{
          backgroundImage: 'radial-gradient(circle at 20% 50%, hsl(350 45% 52%) 0%, transparent 50%), radial-gradient(circle at 80% 50%, hsl(155 25% 45%) 0%, transparent 50%)'
        }} />
        <div className="max-w-6xl mx-auto grid lg:grid-cols-2 gap-16 items-center">
          <div className="space-y-8">
            <div className="space-y-4">
              <p className="text-sm font-medium tracking-wider uppercase text-primary" data-testid="text-tagline">Intentional Dating</p>
              <h1 className="font-serif text-5xl lg:text-6xl font-bold leading-tight tracking-tight" data-testid="text-hero-headline">
                Where real connections
                <span className="text-primary"> flourish</span>
              </h1>
              <p className="text-lg text-muted-foreground leading-relaxed max-w-lg" data-testid="text-hero-description">
                Move beyond endless swiping. Lulou guides you from matching to meaningful conversations to meeting in real life.
              </p>
            </div>

            <form onSubmit={handleSubmit} className="max-w-sm space-y-3" data-testid="form-login" noValidate>
              <div className="space-y-2">
                <Input
                  type="email"
                  placeholder="Enter your email"
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); clearError(); }}
                  required
                  data-testid="input-email"
                  className="h-12"
                />
                <div className="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    placeholder="Password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); clearError(); }}
                    required
                    data-testid="input-password"
                    className="h-12 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    data-testid="button-toggle-password"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
                {mode === "signin" && (
                  <div className="text-right">
                    <button
                      type="button"
                      onClick={handlePasswordReset}
                      disabled={resetLoading || !email.trim()}
                      className="text-xs text-primary hover:underline disabled:opacity-40 disabled:cursor-not-allowed"
                      data-testid="link-forgot-password"
                    >
                      {resetLoading ? "Sending reset email…" : "Forgot password?"}
                    </button>
                  </div>
                )}
              </div>

              {resetSent && (
                <div
                  className="flex items-start gap-2 rounded-md border border-green-200 bg-green-50 px-3 py-2.5 text-sm text-green-800"
                  data-testid="text-reset-sent"
                  role="alert"
                >
                  <CheckCircle className="w-4 h-4 mt-0.5 shrink-0" />
                  <div className="space-y-0.5">
                    <p className="font-medium leading-tight">Reset email sent</p>
                    <p className="text-xs opacity-80">Check your inbox for a link to reset your password.</p>
                  </div>
                </div>
              )}

              {authError && !resetSent && (
                <div
                  className={`rounded-md border px-3 py-3 text-sm animate-in fade-in slide-in-from-top-1 duration-150 ${
                    authError.kind === "network"
                      ? "bg-amber-50 border-amber-200 text-amber-900"
                      : "bg-destructive/10 border-destructive/30 text-destructive"
                  }`}
                  data-testid="text-auth-error"
                  role="alert"
                >
                  <div className="flex items-start gap-2">
                    {authError.kind === "network" ? (
                      <WifiOff className="w-4 h-4 mt-0.5 shrink-0" />
                    ) : (
                      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    )}
                    <div className="space-y-1 flex-1 min-w-0">
                      {/* Human-readable heading */}
                      <p className="font-semibold leading-tight">
                        {authError.kind === "already-exists"
                          ? "Account already exists"
                          : authError.kind === "credentials"
                          ? "Incorrect email or password"
                          : authError.kind === "network"
                          ? "Connection problem"
                          : authError.kind === "auth"
                          ? "Cannot sign in"
                          : mode === "signup"
                          ? "Sign up failed"
                          : "Sign in failed"}
                      </p>
                      {/* Raw error message — always visible at readable size */}
                      <p className="text-sm leading-snug break-words" data-testid="text-auth-error-detail">
                        {authError.message}
                      </p>
                      {/* Action links */}
                      {authError.kind === "already-exists" && (
                        <button
                          type="button"
                          onClick={switchToSignIn}
                          className="text-xs font-medium underline underline-offset-2 mt-0.5"
                          data-testid="button-switch-to-signin"
                        >
                          Sign in instead
                        </button>
                      )}
                      {authError.kind === "credentials" && mode === "signin" && (
                        <button
                          type="button"
                          onClick={handlePasswordReset}
                          disabled={resetLoading || !email.trim()}
                          className="text-xs font-medium underline underline-offset-2 mt-0.5 disabled:opacity-50"
                          data-testid="button-reset-password"
                        >
                          {resetLoading ? "Sending…" : "Forgot your password?"}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )}

              <Button
                type="submit"
                size="lg"
                className="w-full text-base"
                disabled={loading || !email.trim() || !password}
                data-testid="button-submit-auth"
              >
                {loading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {mode === "signup" ? "Creating account..." : "Signing in..."}
                  </>
                ) : (
                  <>
                    <Lock className="w-4 h-4 mr-2" />
                    {mode === "signup" ? "Create Account" : "Sign In"}
                  </>
                )}
              </Button>
              <div className="text-center pt-1">
                <button
                  type="button"
                  onClick={() => { setMode(mode === "signup" ? "signin" : "signup"); setAuthError(null); }}
                  className="text-sm text-primary hover:underline"
                  data-testid="link-toggle-auth-mode"
                >
                  {mode === "signup" ? "Already have an account? Sign in" : "New here? Create account"}
                </button>
              </div>
            </form>

            <div className="flex items-center gap-6 flex-wrap text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <Shield className="w-4 h-4 text-primary" />
                <span>Verified profiles</span>
              </div>
              <div className="flex items-center gap-2">
                <Heart className="w-4 h-4 text-primary" />
                <span>No games</span>
              </div>
            </div>
          </div>

          <div className="relative hidden lg:block">
            <div className="relative rounded-md overflow-hidden aspect-[4/3]">
              <img
                src="/images/bloom-hero.png"
                alt="Lulou - Intentional Dating"
                className="w-full h-full object-cover"
                data-testid="img-hero"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-background/20 to-transparent" />
            </div>
          </div>
        </div>
      </section>

      <section className="py-24 px-6 bg-card/50">
        <div className="max-w-5xl mx-auto">
          <div className="text-center mb-16 space-y-3">
            <p className="text-sm font-medium tracking-wider uppercase text-primary">How It Works</p>
            <h2 className="font-serif text-3xl lg:text-4xl font-bold" data-testid="text-how-it-works">A journey, not a game</h2>
            <p className="text-muted-foreground max-w-xl mx-auto">Every feature in Lulou is designed to move you toward a real connection, not keep you scrolling.</p>
          </div>

          <div className="grid md:grid-cols-3 gap-8">
            <FeatureCard
              icon={<LulouFlowerIcon className="w-5 h-5" />}
              title="Discover with intention"
              description="View one profile at a time. No swiping, no rush. Decide thoughtfully who you want to open up to."
              testId="card-feature-discover"
            />
            <FeatureCard
              icon={<MessageCircle className="w-5 h-5" />}
              title="Conversations that matter"
              description="Limited messages encourage meaningful exchanges. When it's time, Lulou nudges you toward a real call."
              testId="card-feature-message"
            />
            <FeatureCard
              icon={<Phone className="w-5 h-5" />}
              title="From screen to scene"
              description="Your first voice call is always free. Lulou is designed to help you meet, not message forever."
              testId="card-feature-call"
            />
          </div>
        </div>
      </section>

      <section className="py-24 px-6">
        <div className="max-w-4xl mx-auto text-center space-y-8">
          <h2 className="font-serif text-3xl lg:text-4xl font-bold" data-testid="text-cta-heading">Ready to find something real?</h2>
          <p className="text-lg text-muted-foreground max-w-xl mx-auto">
            Lulou is for people who are done with the noise. Step into a calmer, more intentional way to date.
          </p>
        </div>
      </section>

      <footer className="border-t py-8 px-6">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-4 flex-wrap text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            <LulouFlowerIcon className="w-5 h-5 text-primary" />
            <span className="font-serif font-medium text-foreground">Lulou</span>
          </div>
          <p>Designed for real connection.</p>
        </div>
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, description, testId }: { icon: React.ReactNode; title: string; description: string; testId: string }) {
  return (
    <div className="p-6 rounded-md bg-background border space-y-4" data-testid={testId}>
      <div className="w-10 h-10 rounded-md bg-primary/10 flex items-center justify-center text-primary">
        {icon}
      </div>
      <h3 className="font-semibold text-lg">{title}</h3>
      <p className="text-muted-foreground text-sm leading-relaxed">{description}</p>
    </div>
  );
}
