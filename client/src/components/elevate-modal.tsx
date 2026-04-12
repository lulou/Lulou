import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Sparkles, Zap, X, ChevronLeft, ShieldCheck, Lock, Gift } from "lucide-react";

// ── Pricing packs (IDs must match server ELEVATE_PACKS) ──────────────────────
const ELEVATE_PACKAGES = [
  {
    id: "elevate-1",
    label: "1 Elevate",
    price: "$9.99",
    perBoost: "$9.99 per boost",
    description: "One 30-min visibility boost in Discovery & the Intention Wheel",
    badge: null as string | null,
    highlight: false,
    type: "elevate" as const,
    duration: "30 min",
    quantity: 1,
  },
  {
    id: "elevate-3",
    label: "3 Elevates",
    price: "$26.99",
    perBoost: "$9.00 per boost",
    description: "Three 30-min boosts — great for staying consistently visible",
    badge: "Most Popular" as string | null,
    highlight: true,
    type: "elevate" as const,
    duration: "30 min",
    quantity: 3,
  },
  {
    id: "elevate-5",
    label: "5 Elevates",
    price: "$39.99",
    perBoost: "$8.00 per boost",
    description: "Five 30-min boosts at the lowest price — maximum reach",
    badge: "Best Value" as string | null,
    highlight: true,
    type: "elevate" as const,
    duration: "30 min",
    quantity: 5,
  },
];

const SUPER_ELEVATE = {
  id: "super-elevate",
  label: "Super Elevate",
  price: "$34.99",
  perBoost: null,
  description: "Maximum priority placement above all users for 60 minutes",
  badge: null as string | null,
  highlight: false,
  type: "super_elevate" as const,
  duration: "60 min",
  quantity: 1,
};

type PackType = typeof ELEVATE_PACKAGES[0] | typeof SUPER_ELEVATE;

type PendingPackage = {
  id: string;
  label: string;
  price: string;
  type: "elevate" | "super_elevate";
  duration: string;
  isSuper: boolean;
  quantity: number;
};

type ElevateStatus = {
  active: boolean;
  type: string | null;
  expiresAt: string | null;
  elevateCredits: number;
  superElevateCredits: number;
};

export function ElevateModal({ onClose, cancelPath = "/likes" }: { onClose: () => void; cancelPath?: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [step, setStep] = useState<"browse" | "checkout">("browse");
  const [pending, setPending] = useState<PendingPackage | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  const [activating, setActivating] = useState<"elevate" | "super_elevate" | null>(null);

  const [mounted, setMounted] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [dragY, setDragY] = useState(0);
  const isDragging = useRef(false);
  const startY = useRef(0);
  const handleRef = useRef<HTMLDivElement>(null);

  const { data: status } = useQuery<ElevateStatus>({
    queryKey: ["/api/elevate/status"],
    staleTime: 10_000,
  });

  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // ── Bfcache / Stripe cancel recovery ─────────────────────────────────────
  // When the user navigates to Stripe then presses back, the browser restores
  // this page from its back-forward cache with React state intact — including
  // `purchasing: true`. The `pageshow` event with persisted=true signals this;
  // we reset the purchasing state so the modal is interactive again.
  useEffect(() => {
    const handlePageShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        console.log("[ELEVATE] Page restored from bfcache (back from Stripe) — resetting purchase state");
        setPurchasing(false);
        setStep("browse");
        setPending(null);
      }
    };
    const handlePageHide = () => {
      console.log("[ELEVATE] Page hidden — navigating to Stripe checkout");
    };
    window.addEventListener("pageshow", handlePageShow);
    window.addEventListener("pagehide", handlePageHide);
    return () => {
      window.removeEventListener("pageshow", handlePageShow);
      window.removeEventListener("pagehide", handlePageHide);
    };
  }, []);

  const handleClose = () => {
    setLeaving(true);
    setTimeout(onClose, 300);
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (purchasing || activating) return;
    isDragging.current = true;
    startY.current = e.clientY;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const dy = Math.max(0, e.clientY - startY.current);
    setDragY(dy);
  };

  const onPointerUp = () => {
    if (!isDragging.current) return;
    isDragging.current = false;
    if (dragY > 130) {
      handleClose();
    } else {
      setDragY(0);
    }
  };

  const openCheckout = (pkg: PackType) => {
    setPending({
      id: pkg.id,
      label: pkg.label,
      price: pkg.price,
      type: pkg.type,
      duration: pkg.duration,
      isSuper: pkg.type === "super_elevate",
      quantity: pkg.quantity,
    });
    setStep("checkout");
  };

  // Redirect to Stripe checkout (no immediate activation)
  const confirmPurchase = async () => {
    if (!pending) return;
    setPurchasing(true);
    try {
      const res = await apiRequest("POST", "/api/stripe/elevate-checkout", { packId: pending.id, cancelPath });
      const data = await res.json();
      if (!data.url) {
        throw new Error(data.message ?? "No checkout URL returned");
      }
      // Navigate to Stripe-hosted checkout
      window.location.assign(data.url);
    } catch (err: any) {
      const msg = err?.message ?? "Something went wrong. Please try again.";
      console.error("[ELEVATE] Checkout failed:", msg);
      toast({
        title: "Payment couldn't be started",
        description: msg,
        variant: "destructive",
      });
      setPurchasing(false);
    }
  };

  // Use an existing credit to activate immediately
  const activateNow = async (type: "elevate" | "super_elevate") => {
    setActivating(type);
    try {
      const res = await apiRequest("POST", "/api/elevate/activate", { type });
      const data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.message ?? "Activation failed");
      qc.invalidateQueries({ queryKey: ["/api/elevate/status"] });
      qc.invalidateQueries({ queryKey: ["/api/elevate/session-stats"] });
      const label = type === "super_elevate" ? "Super Elevate" : "Elevate";
      const duration = type === "super_elevate" ? "60 minutes" : "30 minutes";
      toast({
        title: `${label} is now live`,
        description: `Your profile has boosted visibility for ${duration}.`,
      });
      handleClose();
    } catch (err: any) {
      toast({
        title: "Couldn't activate",
        description: err?.message ?? "Please try again.",
        variant: "destructive",
      });
    } finally {
      setActivating(null);
    }
  };

  const isOut = !mounted || leaving;
  const translateY = isOut ? "100%" : `${dragY}px`;
  const transition = isDragging.current
    ? "none"
    : "transform 300ms cubic-bezier(0.32, 0.72, 0, 1)";
  const backdropOpacity = isOut ? 0 : 1 - dragY / 400;

  const elevateCredits = status?.elevateCredits ?? 0;
  const superElevateCredits = status?.superElevateCredits ?? 0;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" data-testid="modal-elevate">
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        style={{ opacity: backdropOpacity, transition: "opacity 300ms ease" }}
        onClick={handleClose}
      />

      <div
        className="relative w-full max-w-md mx-auto bg-background rounded-t-3xl shadow-2xl flex flex-col"
        style={{ transform: `translateY(${translateY})`, transition, maxHeight: "90dvh" }}
      >
        {/* Drag handle row */}
        <div className="flex-shrink-0 flex items-center px-4 pt-3 pb-1 select-none touch-none">
          <div className="w-8" />
          <div
            ref={handleRef}
            className="flex-1 flex justify-center cursor-grab active:cursor-grabbing"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          >
            <div className="h-1.5 w-12 bg-border rounded-full" />
          </div>
          <button
            className="w-8 h-8 flex items-center justify-center rounded-full bg-muted hover:bg-muted/80 active:bg-muted/60 transition-colors shrink-0"
            onClick={handleClose}
            disabled={!!(purchasing || activating)}
            aria-label="Close"
            data-testid="button-elevate-close"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {step === "browse" ? (
          <BrowseStep
            onBuy={openCheckout}
            onActivate={activateNow}
            activating={activating}
            elevateCredits={elevateCredits}
            superElevateCredits={superElevateCredits}
            boostActive={!!status?.active}
          />
        ) : pending ? (
          <CheckoutStep
            pending={pending}
            purchasing={purchasing}
            onBack={() => setStep("browse")}
            onConfirm={confirmPurchase}
          />
        ) : null}
      </div>
    </div>
  );
}

// ── Browse step ──────────────────────────────────────────────────────────────

function BrowseStep({
  onBuy,
  onActivate,
  activating,
  elevateCredits,
  superElevateCredits,
  boostActive,
}: {
  onBuy: (pkg: PackType) => void;
  onActivate: (type: "elevate" | "super_elevate") => void;
  activating: "elevate" | "super_elevate" | null;
  elevateCredits: number;
  superElevateCredits: number;
  boostActive: boolean;
}) {
  const hasElevateCredits = elevateCredits > 0;
  const hasSuperCredits = superElevateCredits > 0;

  return (
    <div className="overflow-y-auto overscroll-contain flex-1">
      <div className="px-6 pt-4 pb-2">
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="w-5 h-5 text-primary" />
          <h2 className="font-serif text-xl font-bold">Elevate Your Profile</h2>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          Boost your visibility in Discovery and the Intention Wheel. More eyes on your profile, faster connections.
        </p>
      </div>

      {/* Credits banner — shown only when user has unused credits */}
      {(hasElevateCredits || hasSuperCredits) && (
        <div className="px-6 pb-2 pt-3">
          <div className="rounded-2xl bg-primary/8 border border-primary/20 p-4 space-y-2.5">
            <div className="flex items-center gap-2 mb-0.5">
              <Gift className="w-4 h-4 text-primary" />
              <p className="text-sm font-semibold text-primary">You have unused boosts</p>
            </div>
            {hasElevateCredits && (
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">{elevateCredits} Elevate boost{elevateCredits > 1 ? "s" : ""}</p>
                  <p className="text-xs text-muted-foreground">30 min · 3× visibility each</p>
                </div>
                <button
                  className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-60 active:scale-[0.97] transition-all"
                  onClick={() => onActivate("elevate")}
                  disabled={!!activating || boostActive}
                  data-testid="button-activate-elevate-credit"
                >
                  {activating === "elevate" ? (
                    <span className="flex items-center gap-1.5">
                      <span className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                      ...
                    </span>
                  ) : boostActive ? "Active" : "Activate"}
                </button>
              </div>
            )}
            {hasSuperCredits && (
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">{superElevateCredits} Super Elevate boost{superElevateCredits > 1 ? "s" : ""}</p>
                  <p className="text-xs text-muted-foreground">60 min · 8× visibility each</p>
                </div>
                <button
                  className="px-4 py-2 rounded-xl bg-primary text-primary-foreground text-sm font-semibold disabled:opacity-60 active:scale-[0.97] transition-all"
                  onClick={() => onActivate("super_elevate")}
                  disabled={!!activating || boostActive}
                  data-testid="button-activate-super-credit"
                >
                  {activating === "super_elevate" ? (
                    <span className="flex items-center gap-1.5">
                      <span className="w-3.5 h-3.5 rounded-full border-2 border-white/40 border-t-white animate-spin" />
                      ...
                    </span>
                  ) : boostActive ? "Active" : "Activate"}
                </button>
              </div>
            )}
            {boostActive && (
              <p className="text-xs text-muted-foreground pt-1">A boost is currently running. Credits will be available to use when it ends.</p>
            )}
          </div>
        </div>
      )}

      {/* Elevate packs */}
      <div className="px-6 pb-2 pt-4 space-y-2.5">
        {ELEVATE_PACKAGES.map(pkg => (
          <button
            key={pkg.id}
            className={[
              "w-full rounded-2xl border text-left transition-all relative overflow-hidden",
              pkg.highlight
                ? "border-primary/60 bg-primary/5 shadow-sm active:bg-primary/10"
                : "border-border bg-card active:bg-muted/60",
            ].join(" ")}
            onClick={() => onBuy(pkg)}
            data-testid={`button-elevate-${pkg.id}`}
          >
            {pkg.badge && (
              <span
                className={[
                  "absolute top-3.5 right-3.5 text-xs font-semibold px-2.5 py-0.5 rounded-full",
                  pkg.badge === "Most Popular"
                    ? "bg-primary text-primary-foreground"
                    : "bg-foreground text-background",
                ].join(" ")}
                data-testid={`badge-elevate-${pkg.id}`}
              >
                {pkg.badge}
              </span>
            )}
            <div className="p-4">
              <div className="flex items-center gap-3 pr-28">
                <div className={[
                  "w-8 h-8 rounded-full flex items-center justify-center shrink-0",
                  pkg.highlight ? "bg-primary/15" : "bg-muted",
                ].join(" ")}>
                  <Sparkles className={["w-3.5 h-3.5", pkg.highlight ? "text-primary" : "text-muted-foreground"].join(" ")} />
                </div>
                <p className={["font-semibold text-sm", pkg.highlight ? "text-primary" : "text-foreground"].join(" ")}>
                  {pkg.label}
                </p>
              </div>
              <p className="text-xs text-muted-foreground mt-1.5 ml-11">{pkg.description}</p>
              <div className="flex items-baseline gap-2 mt-2 ml-11">
                <span className={["text-xl font-bold", pkg.highlight ? "text-primary" : "text-foreground"].join(" ")}>
                  {pkg.price}
                </span>
                <span className="text-xs text-muted-foreground">{pkg.perBoost}</span>
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* Divider */}
      <div className="px-6 pb-2 pt-3">
        <div className="relative py-2">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t border-border" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-background px-3 text-muted-foreground font-medium tracking-widest uppercase">Super</span>
          </div>
        </div>
      </div>

      {/* Super Elevate */}
      <div className="px-6 pb-8">
        <button
          className="w-full rounded-2xl text-left transition-all overflow-hidden relative active:opacity-80"
          style={{
            background: "linear-gradient(135deg, hsl(350 45% 20%), hsl(350 45% 14%))",
            border: "1px solid hsl(350 45% 35%)",
            boxShadow: "0 4px 24px hsl(350 45% 30% / 0.25), inset 0 1px 0 hsl(350 45% 50% / 0.15)",
          }}
          onClick={() => onBuy(SUPER_ELEVATE)}
          data-testid="button-super-elevate"
        >
          <div
            className="absolute top-0 right-0 w-40 h-40 rounded-full opacity-10 pointer-events-none"
            style={{ background: "radial-gradient(circle, hsl(350 45% 70%), transparent)", transform: "translate(30%, -30%)" }}
          />
          <div className="p-5">
            <div className="flex items-start gap-3">
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                style={{ background: "hsl(350 45% 52% / 0.25)", border: "1px solid hsl(350 45% 52% / 0.4)" }}
              >
                <Zap className="w-4 h-4 text-primary" />
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <p className="font-serif font-bold text-base text-primary">{SUPER_ELEVATE.label}</p>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full text-primary" style={{ background: "hsl(350 45% 52% / 0.2)", border: "1px solid hsl(350 45% 52% / 0.3)" }}>
                    60 min
                  </span>
                  <span className="text-xs font-semibold px-2 py-0.5 rounded-full text-primary" style={{ background: "hsl(350 45% 52% / 0.2)", border: "1px solid hsl(350 45% 52% / 0.3)" }}>
                    8× visibility
                  </span>
                </div>
                <p className="text-sm text-primary/70 mt-1 leading-snug">{SUPER_ELEVATE.description}</p>
                <p className="text-2xl font-bold text-primary mt-3">{SUPER_ELEVATE.price}</p>
              </div>
            </div>
          </div>
        </button>
      </div>
    </div>
  );
}

// ── Checkout step ─────────────────────────────────────────────────────────────

function CheckoutStep({
  pending,
  purchasing,
  onBack,
  onConfirm,
}: {
  pending: PendingPackage;
  purchasing: boolean;
  onBack: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="overflow-y-auto overscroll-contain flex-1 flex flex-col">
      {/* Back nav */}
      <div className="px-6 pt-3 pb-1">
        <button
          className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground transition-colors -ml-1"
          onClick={onBack}
          disabled={purchasing}
          data-testid="button-checkout-back"
        >
          <ChevronLeft className="w-4 h-4" />
          Back
        </button>
      </div>

      {/* Order summary */}
      <div className="px-6 pt-2 pb-4 flex-1">
        <h2 className="font-serif text-xl font-bold mb-1">Confirm Purchase</h2>
        <p className="text-sm text-muted-foreground mb-6">Review your order before completing payment.</p>

        {/* Package card */}
        <div
          className="rounded-2xl p-5 mb-5"
          style={pending.isSuper
            ? { background: "linear-gradient(135deg, hsl(350 45% 18%), hsl(350 45% 12%))", border: "1px solid hsl(350 45% 32%)" }
            : { background: "hsl(350 45% 52% / 0.06)", border: "1px solid hsl(350 45% 52% / 0.25)" }
          }
        >
          <div className="flex items-center gap-3 mb-3">
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center shrink-0"
              style={{ background: "hsl(350 45% 52% / 0.2)", border: "1px solid hsl(350 45% 52% / 0.3)" }}
            >
              {pending.isSuper
                ? <Zap className="w-5 h-5 text-primary" />
                : <Sparkles className="w-5 h-5 text-primary" />
              }
            </div>
            <div>
              <p className="font-semibold text-base text-primary">{pending.label}</p>
              <p className="text-xs text-muted-foreground">
                {pending.isSuper ? "60 min boost" : `${pending.quantity} × 30 min boost${pending.quantity > 1 ? "s" : ""}`}
              </p>
            </div>
          </div>

          <div className="space-y-1.5 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Duration per use</span>
              <span className="font-medium">{pending.duration}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Visibility boost</span>
              <span className="font-medium">{pending.isSuper ? "8× (maximum)" : "3× (elevated)"}</span>
            </div>
            {!pending.isSuper && pending.quantity > 1 && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Boosts included</span>
                <span className="font-medium">{pending.quantity}</span>
              </div>
            )}
            <div className="flex justify-between border-t border-border/50 pt-2 mt-2">
              <span className="font-semibold">Total</span>
              <span className="font-bold text-lg text-primary">{pending.price}</span>
            </div>
          </div>
        </div>

        {/* Trust indicators */}
        <div className="flex items-center gap-4 mb-6 px-1">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="w-3.5 h-3.5 text-green-500" />
            Secure payment
          </div>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Gift className="w-3.5 h-3.5 text-muted-foreground" />
            Credits saved to your account
          </div>
        </div>

        {/* Pay button */}
        <button
          className="w-full py-4 rounded-2xl font-bold text-base transition-all disabled:opacity-60 active:scale-[0.98]"
          style={pending.isSuper
            ? {
                background: purchasing
                  ? "hsl(350 45% 30%)"
                  : "linear-gradient(135deg, hsl(350 45% 50%), hsl(350 45% 42%))",
                color: "white",
                boxShadow: purchasing ? "none" : "0 4px 20px hsl(350 45% 40% / 0.4)",
              }
            : {
                background: purchasing ? "hsl(350 45% 40%)" : "hsl(350 45% 52%)",
                color: "white",
                boxShadow: purchasing ? "none" : "0 4px 16px hsl(350 45% 40% / 0.35)",
              }
          }
          onClick={onConfirm}
          disabled={purchasing}
          data-testid="button-confirm-purchase"
        >
          {purchasing ? (
            <span className="flex items-center justify-center gap-2">
              <span className="w-4 h-4 rounded-full border-2 border-white/40 border-t-white animate-spin" />
              Opening Stripe…
            </span>
          ) : (
            `Pay ${pending.price}`
          )}
        </button>

        <p className="text-center text-xs text-muted-foreground mt-3">
          You'll be redirected to Stripe. Credits are added to your account immediately after payment.
        </p>
      </div>
    </div>
  );
}
