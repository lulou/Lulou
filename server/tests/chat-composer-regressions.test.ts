import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("chat composer regressions", () => {
  it("keeps the composer unified without a standalone send control", () => {
    const messaging = readFileSync("client/src/pages/messaging.tsx", "utf8");
    const matches = readFileSync("client/src/pages/matches.tsx", "utf8");
    const activeComposerStart = matches.indexOf('data-testid={`chat-composer-surface-${match.id}`}');
    const activeComposerEnd = matches.indexOf("/* ── Comment filter confirmation ── */", activeComposerStart);
    const activeComposer = matches.slice(activeComposerStart, activeComposerEnd);

    expect(messaging).not.toContain('data-testid="button-send"');
    expect(messaging).not.toContain("<Send ");
    expect(messaging).toContain('data-testid="input-message"');
    expect(messaging).toContain("messageInputRef");
    expect(messaging).toContain('data-testid="chat-composer-surface"');
    expect(messaging).toContain("rounded-[1.5rem]");
    expect(messaging).toContain('data-testid="button-mic-input"');
    expect(messaging).toContain('data-testid="button-ai-starters"');
    expect(messaging).toContain('data-testid="button-phone-composer"');
    expect(messaging).toContain('data-testid="button-video-composer"');
    expect(messaging).not.toContain('data-testid="button-send-message"');

    // The expanded Connection view is the composer rendered on iPhone.
    expect(activeComposerStart).toBeGreaterThan(-1);
    expect(activeComposer).toContain('data-ui-version="composer-104"');
    expect(activeComposer).toContain('data-testid={`input-message-${match.id}`}');
    expect(activeComposer).toContain("min-h-8");
    expect(activeComposer).toContain("text-[15px]");
    expect(activeComposer).toContain("gap-0.5");
    expect(activeComposer).not.toContain("border-t border-foreground/[0.06]");
    expect(activeComposer).toContain('data-testid={`button-mic-input-${match.id}`}');
    expect(activeComposer).toContain('data-testid={`button-ai-starters-${match.id}`}');
    expect(activeComposer).toContain('data-testid={`button-phone-composer-${match.id}`}');
    expect(activeComposer).toContain('data-testid={`button-video-composer-${match.id}`}');
    expect(activeComposer).toContain("message.length >= MAX_CHARS - 50");
    expect(activeComposer).not.toContain('data-testid={`button-send-${match.id}`}');
    expect(activeComposer).not.toContain("<Send ");
    expect(activeComposer).not.toContain("!inputFocused");
    expect(matches).toContain("useLayoutEffect");
    expect(matches).toContain('textarea.style.overflowY = measuredHeight > 132 ? "auto" : "hidden"');
    expect(matches).not.toContain('data-testid={`button-send-${match.id}`}');
  });

  it("preserves keyboard submission, the character cap, and internal input scrolling", () => {
    const messaging = readFileSync("client/src/pages/messaging.tsx", "utf8");

    expect(messaging).toContain("MAX_CHARS = 500");
    expect(messaging).toContain("e.target.value.slice(0, MAX_CHARS)");
    expect(messaging).toContain('e.key === "Enter" && !e.shiftKey');
    expect(messaging).toContain("!sendMessage.isPending");
    expect(messaging).toContain('textarea.style.overflowY = textarea.scrollHeight > 120 ? "auto" : "hidden"');
  });

  it("keeps non-visible source markers for production deployment verification", () => {
    const messaging = readFileSync("client/src/pages/messaging.tsx", "utf8");
    const discover = readFileSync("client/src/pages/discover.tsx", "utf8");

    expect(messaging).toContain('data-ui-version="composer-104"');
    expect(discover).toContain('data-ui-version="discover-103"');
  });

  it("keeps near-bottom conversations anchored through viewport and composer changes", () => {
    const matches = readFileSync("client/src/pages/matches.tsx", "utf8");

    expect(matches).toContain("el.scrollHeight - el.scrollTop - el.clientHeight <= 140");
    expect(matches).toContain("scheduleBottomAnchor");
    expect(matches).toContain('"viewport-or-composer-layout"');
    expect(matches).toContain('"bottom-region-resize"');
    expect(matches).toContain("ResizeObserver");
    expect(matches).toContain("forceScrollRef.current = isAtBottomRef.current");
  });

  it("keeps Conversation Starters above the composer with recoverable query states", () => {
    const matches = readFileSync("client/src/pages/matches.tsx", "utf8");
    const panel = matches.indexOf('data-testid={`ai-starters-panel-${match.id}`}');
    const composer = matches.indexOf('data-testid={`chat-composer-surface-${match.id}`}');

    expect(panel).toBeGreaterThan(-1);
    expect(panel).toBeLessThan(composer);
    expect(matches).toContain("aiStartersLoading");
    expect(matches).toContain("aiStartersError");
    expect(matches).toContain("refetchAIStarters");
    expect(matches).toContain('data-testid={`button-retry-ai-starters-${match.id}`}');
    expect(matches).toContain("setShowAIStarters(false)");
  });

  it("uses an explicit recorder lifecycle and retries each failed Blob only once", () => {
    const matches = readFileSync("client/src/pages/matches.tsx", "utf8");
    const routes = readFileSync("server/routes.ts", "utf8");

    expect(matches).toContain('type VoicePhase = "idle" | "requesting_permission" | "recording" | "processing" | "sending" | "failed"');
    expect(matches).toContain('setVoicePhase("requesting_permission")');
    expect(matches).toContain('setVoicePhase("processing")');
    expect(matches).toContain('setVoicePhase("sending")');
    expect(matches).toContain('releaseMicStream("recording-stopped")');
    expect(matches).toContain("capturedMimeType");
    expect(matches).toContain("pendingVoiceRetryIdsRef");
    expect(matches).toContain("recordingGenerationRef");
    expect(matches).toContain('formData.append("clientRequestId", tempId)');
    expect(matches).toContain("onTouchEnd");
    expect(matches).toContain('voicePhase === "recording"');
    expect(routes).toContain("const clientRequestId");
    expect(routes).toContain("idempotent retry clientRequestId");
    expect(routes).toContain("upsert: !!clientRequestId");
  });
});