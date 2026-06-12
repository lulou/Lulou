import { useState, useEffect, useCallback, useRef } from "react";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useLanguageContext } from "@/contexts/language-context";
import { type TranslationKey } from "@/lib/i18n";

export type MatchCelebration = { firstName: string; photo?: string; matchId?: string };

const MATCH_TAGLINE_KEYS: TranslationKey[] = [
  "match_tagline_1",
  "match_tagline_2",
  "match_tagline_3",
  "match_tagline_4",
  "match_tagline_5",
  "match_tagline_6",
  "match_tagline_7",
  "match_tagline_8",
];

export function MatchOverlay({
  celebration,
  onClose,
}: {
  celebration: MatchCelebration;
  onClose: () => void;
}) {
  const { t } = useLanguageContext();
  const [, navigate] = useLocation();
  const [phase, setPhase] = useState<"enter" | "visible" | "exit">("enter");
  const taglineKey = useRef(
    MATCH_TAGLINE_KEYS[Math.floor(Math.random() * MATCH_TAGLINE_KEYS.length)],
  ).current;

  useEffect(() => {
    const id = setTimeout(() => setPhase("visible"), 60);
    return () => clearTimeout(id);
  }, []);

  const handleClose = useCallback(() => {
    setPhase("exit");
    setTimeout(onClose, 380);
  }, [onClose]);

  useEffect(() => {
    const id = setTimeout(handleClose, 9000);
    return () => clearTimeout(id);
  }, [handleClose]);

  const handleSendMessage = useCallback(() => {
    setPhase("exit");
    const matchId = celebration.matchId;
    setTimeout(() => {
      onClose();
      if (matchId) navigate(`/messages/${matchId}`);
    }, 380);
  }, [onClose, navigate, celebration.matchId]);

  const isVisible = phase === "visible";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center p-4 sm:p-6"
      onClick={handleClose}
      data-testid="overlay-match-celebration"
      style={{
        background: "rgba(10,8,18,0.76)",
        backdropFilter: "blur(8px)",
        WebkitBackdropFilter: "blur(8px)",
        opacity: phase === "exit" ? 0 : 1,
        transition: "opacity 380ms ease",
      }}
    >
      <div
        className="w-full max-w-sm bg-background rounded-3xl overflow-hidden shadow-2xl"
        onClick={e => e.stopPropagation()}
        style={{
          transform: isVisible ? "translateY(0) scale(1)" : "translateY(56px) scale(0.94)",
          opacity: isVisible ? 1 : 0,
          transition:
            "transform 520ms cubic-bezier(0.34, 1.28, 0.64, 1), opacity 380ms ease",
        }}
      >
        {/* Photo / avatar area */}
        <div className="relative h-64 bg-muted overflow-hidden">
          {celebration.photo ? (
            <img
              src={celebration.photo}
              alt={celebration.firstName}
              className="w-full h-full object-cover"
              style={{ objectPosition: "center top" }}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-primary/8">
              <Avatar className="w-24 h-24">
                <AvatarFallback className="text-5xl bg-primary/12 text-primary font-serif">
                  {celebration.firstName?.[0] ?? "♡"}
                </AvatarFallback>
              </Avatar>
            </div>
          )}
          {/* Gradient fade to card background */}
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(to bottom, transparent 35%, hsl(var(--background) / 0.5) 75%, hsl(var(--background)) 100%)",
            }}
          />
          {/* "Connected" pill */}
          <div
            className="absolute top-4 inset-x-0 flex justify-center"
            style={{
              opacity: isVisible ? 1 : 0,
              transition: "opacity 420ms ease 300ms",
            }}
          >
            <span
              className="bg-primary text-white text-[11px] font-bold tracking-[0.15em] uppercase px-5 py-1.5 rounded-full shadow-lg"
              data-testid="text-match-connected"
            >
              Connected
            </span>
          </div>
        </div>

        {/* Content */}
        <div className="px-6 pt-3 pb-7 space-y-5">
          {/* Name + tagline */}
          <div
            className="text-center space-y-1.5"
            style={{
              transform: isVisible ? "translateY(0)" : "translateY(14px)",
              opacity: isVisible ? 1 : 0,
              transition: "transform 480ms ease 200ms, opacity 380ms ease 200ms",
            }}
          >
            <h2
              className="font-serif text-3xl font-bold tracking-tight"
              data-testid="text-blooming-amazing"
            >
              {celebration.firstName}
            </h2>
            <p
              className="text-sm text-muted-foreground italic leading-relaxed"
              data-testid="text-match-made"
            >
              {t(taglineKey)}
            </p>
          </div>

          {/* CTAs */}
          <div
            className="space-y-2.5"
            style={{
              transform: isVisible ? "translateY(0)" : "translateY(14px)",
              opacity: isVisible ? 1 : 0,
              transition: "transform 480ms ease 340ms, opacity 380ms ease 340ms",
            }}
          >
            {celebration.matchId ? (
              <Button
                className="w-full h-12 text-base font-semibold rounded-2xl"
                onClick={handleSendMessage}
                data-testid="button-send-message"
              >
                Send a message
              </Button>
            ) : (
              <Button
                className="w-full h-12 text-base font-semibold rounded-2xl"
                onClick={handleClose}
                data-testid="button-send-message"
              >
                View match
              </Button>
            )}
            <Button
              variant="ghost"
              className="w-full h-10 text-sm text-muted-foreground rounded-2xl"
              onClick={handleClose}
              data-testid="button-keep-discovering"
            >
              Keep discovering
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
