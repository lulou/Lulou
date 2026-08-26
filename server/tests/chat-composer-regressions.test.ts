import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("chat composer regressions", () => {
  it("keeps the composer unified without a standalone send control", () => {
    const messaging = readFileSync("client/src/pages/messaging.tsx", "utf8");
    const matches = readFileSync("client/src/pages/matches.tsx", "utf8");
    const activeComposerStart = matches.indexOf('data-testid={`chat-composer-surface-${match.id}`}');
    const activeComposerEnd = matches.indexOf("/* ── AI Starters panel ── */", activeComposerStart);
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
    expect(activeComposer).toContain('data-testid={`input-message-${match.id}`}');
    expect(activeComposer).toContain('data-testid={`button-mic-input-${match.id}`}');
    expect(activeComposer).toContain('data-testid={`button-ai-starters-${match.id}`}');
    expect(activeComposer).toContain('data-testid={`button-phone-composer-${match.id}`}');
    expect(activeComposer).toContain('data-testid={`button-video-composer-${match.id}`}');
    expect(activeComposer).toContain("message.length >= MAX_CHARS - 50");
    expect(activeComposer).not.toContain('data-testid={`button-send-${match.id}`}');
    expect(activeComposer).not.toContain("<Send ");
    expect(activeComposer).not.toContain("!inputFocused");
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
});