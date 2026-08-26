import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("chat composer regressions", () => {
  it("keeps the composer unified without a standalone send control", () => {
    const messaging = readFileSync("client/src/pages/messaging.tsx", "utf8");

    expect(messaging).not.toContain('data-testid="button-send"');
    expect(messaging).not.toContain("<Send ");
    expect(messaging).toContain('data-testid="input-message"');
    expect(messaging).toContain("messageInputRef");
    expect(messaging).toContain("rounded-[1.45rem]");
    expect(messaging).toContain('data-testid="button-mic-input"');
    expect(messaging).toContain('data-testid="button-ai-starters"');
    expect(messaging).toContain('data-testid="button-phone-composer"');
    expect(messaging).toContain('data-testid="button-video-composer"');
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