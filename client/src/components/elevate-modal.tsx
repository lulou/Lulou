import { useState, useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Sparkles, Zap, X } from "lucide-react";

const ELEVATE_PACKAGES = [
  {
    id: "elevate-1",
    label: "1 Elevate",
    price: "$9.99",
    perBoost: "$9.99 per boost",
    description: "One visibility boost in Discovery & the Intention Wheel",
    badge: null as string | null,
    highlight: false,
  },
  {
    id: "elevate-3",
    label: "3 Elevates",
    price: "$26.99",
    perBoost: "$9.00 per boost",
    description: "Three boosts — great for staying consistently visible",
    badge: "Most Popular" as string | null,
    highlight: true,
  },
  {
    id: "elevate-5",
    label: "5 Elevates",
    price: "$39.99",
    perBoost: "$8.00 per boost",
    description: "Five boosts at the lowest price — maximum reach",
    badge: "Best Value" as string | null,
    highlight: true,
  },
];

const SUPER_ELEVATE = {
  id: "super-elevate",
  label: "Super Elevate",
  price: "$34.99",
  description: "Maximum priority placement above all users for 60 minutes",
};

export function ElevateModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [purchasing, setPurchasing] = useState(false);

  // ── Bottom-sheet animation state ───────────────────────────────────────────
  const [mounted, setMounted] = useState(false);   // drives CSS transition in
  const [leaving, setLeaving] = useState(false);   // drives CSS transition out
  const [dragY, setDragY] = useState(0);
  const isDragging = useRef(false);
  const startY = useRef(0);
  const handleRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLDivElement>(null);

  // Animate in on mount (defer one frame so the initial translateY=100% renders first)
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);

  const handleClose = () => {
    setLeaving(true);
    setTimeout(onClose, 300);
  };

  // ── Drag gesture (pointer events on handle only) ────────────────────────────
  const onPointerDown = (e: React.PointerEvent) => {
    if (purchasing) return;
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

  // ── Purchase handler ────────────────────────────────────────────────────────
  const handlePurchase = async (packageId: string, label: string) => {
    const elevateType = packageId === "super-elevate" ? "super_elevate" : "elevate";
    setPurchasing(true);
    setSelected(packageId);
    try {
      const res = await apiRequest("POST", "/api/elevate", { type: elevateType });
      const data = await res.json();
      if (!data.success) throw new Error("Activation failed");
      const durationLabel = data.durationMinutes === 60 ? "60 minutes" : "30 minutes";
      queryClient.invalidateQueries({ queryKey: ["/api/elevate/status"] });
      toast({
        title: `${label} is now live`,
        description: `Your profile has boosted visibility for ${durationLabel}. More people will find you.`,
      });
      handleClose();
    } catch {
      toast({
        title: "Something went wrong",
        description: "Couldn't activate your boost. Please try again.",
        variant: "destructive",
      });
    } finally {
      setPurchasing(false);
      setSelected(null);
    }
  };

  // ── Computed transform / transition ─────────────────────────────────────────
  const isOut = !mounted || leaving;
  const translateY = isOut ? "100%" : `${dragY}px`;
  const transition = isDragging.current
    ? "none"
    : "transform 300ms cubic-bezier(0.32, 0.72, 0, 1)";

  const backdropOpacity = isOut ? 0 : 1 - dragY / 400;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center" data-testid="modal-elevate">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        style={{ opacity: backdropOpacity, transition: "opacity 300ms ease" }}
        onClick={handleClose}
      />

      {/* Sheet */}
      <div
        ref={sheetRef}
        className="relative w-full max-w-md mx-auto bg-background rounded-t-3xl shadow-2xl flex flex-col"
        style={{
          transform: `translateY(${translateY})`,
          transition,
          maxHeight: "90dvh",
        }}
      >
        {/* Drag handle + close button row */}
        <div className="flex-shrink-0 flex items-center px-4 pt-3 pb-1 select-none touch-none">
          {/* spacer so pill stays centred */}
          <div className="w-8" />

          {/* draggable pill — centred */}
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

          {/* close button */}
          <button
            className="w-8 h-8 flex items-center justify-center rounded-full bg-muted hover:bg-muted/80 active:bg-muted/60 transition-colors shrink-0"
            onClick={handleClose}
            disabled={purchasing}
            aria-label="Close"
            data-testid="button-elevate-close"
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* Scrollable content */}
        <div className="overflow-y-auto overscroll-contain flex-1">
          {/* Header */}
          <div className="px-6 pt-4 pb-2">
            <div className="flex items-center gap-2 mb-1">
              <Sparkles className="w-5 h-5 text-primary" />
              <h2 className="font-serif text-xl font-bold">Elevate Your Profile</h2>
            </div>
            <p className="text-sm text-muted-foreground leading-relaxed">
              Boost your visibility in Discovery and the Intention Wheel. More eyes on your profile, faster connections.
            </p>
          </div>

          {/* Elevate packages */}
          <div className="px-6 pb-2 pt-4 space-y-2.5">
            {ELEVATE_PACKAGES.map(pkg => (
              <button
                key={pkg.id}
                className={[
                  "w-full rounded-2xl border text-left transition-all relative overflow-hidden",
                  pkg.highlight
                    ? "border-primary/60 bg-primary/5 shadow-sm active:bg-primary/10"
                    : "border-border bg-card active:bg-muted/60",
                  selected === pkg.id && purchasing ? "opacity-70" : "",
                ].join(" ")}
                onClick={() => handlePurchase(pkg.id, pkg.label)}
                disabled={purchasing}
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
                      {selected === pkg.id && purchasing
                        ? <div className="w-3.5 h-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                        : <Sparkles className={["w-3.5 h-3.5", pkg.highlight ? "text-primary" : "text-muted-foreground"].join(" ")} />
                      }
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
                <span className="bg-background px-3 text-muted-foreground font-medium tracking-widest uppercase">
                  Super
                </span>
              </div>
            </div>
          </div>

          {/* Super Elevate */}
          <div className="px-6 pb-8">
            <button
              className="w-full rounded-2xl text-left transition-all disabled:opacity-70 overflow-hidden relative active:opacity-80"
              style={{
                background: "linear-gradient(135deg, hsl(350 45% 20%), hsl(350 45% 14%))",
                border: "1px solid hsl(350 45% 35%)",
                boxShadow: "0 4px 24px hsl(350 45% 30% / 0.25), inset 0 1px 0 hsl(350 45% 50% / 0.15)",
              }}
              onClick={() => handlePurchase(SUPER_ELEVATE.id, SUPER_ELEVATE.label)}
              disabled={purchasing}
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
                    {selected === SUPER_ELEVATE.id && purchasing
                      ? <div className="w-4 h-4 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                      : <Zap className="w-4 h-4 text-primary" />
                    }
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <p className="font-serif font-bold text-base text-primary">{SUPER_ELEVATE.label}</p>
                      <span
                        className="text-xs font-semibold px-2 py-0.5 rounded-full text-primary"
                        style={{ background: "hsl(350 45% 52% / 0.2)", border: "1px solid hsl(350 45% 52% / 0.3)" }}
                      >
                        60 min
                      </span>
                      <span
                        className="text-xs font-semibold px-2 py-0.5 rounded-full text-primary"
                        style={{ background: "hsl(350 45% 52% / 0.2)", border: "1px solid hsl(350 45% 52% / 0.3)" }}
                      >
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
      </div>
    </div>
  );
}
