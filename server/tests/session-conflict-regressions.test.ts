import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isCurrentSessionReplacement } from "../../client/src/lib/session-conflict";

describe("session conflict ownership", () => {
  it("accepts only an exact replacement for the current authenticated session", () => {
    const detail = { reason: "session_replaced", sessionId: "session-a", source: "api" };
    expect(isCurrentSessionReplacement(detail, "user-a", "session-a")).toBe(true);
    expect(isCurrentSessionReplacement(detail, "user-b", "session-b")).toBe(false);
    expect(isCurrentSessionReplacement(detail, null, "session-a")).toBe(false);
    expect(isCurrentSessionReplacement({ ...detail, reason: "invalid_session" }, "user-a", "session-a")).toBe(false);
    expect(isCurrentSessionReplacement(undefined, "user-a", "session-a")).toBe(false);
  });

  it("does not persist a global forced-logout reason in browser storage", () => {
    const auth = readFileSync("client/src/hooks/use-auth.ts", "utf8");
    const landing = readFileSync("client/src/pages/landing.tsx", "utf8");
    expect(auth).not.toContain('sessionStorage.setItem("lulou_forced_logout"');
    expect(landing).not.toContain('sessionStorage.getItem("lulou_forced_logout"');
    expect(auth).toContain("invalidatedUserId: currentUser.id");
    expect(auth).toContain("invalidatedSessionId: currentSessionId");
  });

  it("dispatches only attributed session_replaced responses", () => {
    const queryClient = readFileSync("client/src/lib/queryClient.ts", "utf8");
    expect(queryClient).toContain("sentSessionId && sentSessionId === currentSessionId");
    expect(queryClient).toContain("sessionId && sessionId === currentSessionId");
    expect(queryClient).toContain('reason: "session_replaced", sessionId: sentSessionId, source: "api"');
    expect(queryClient).not.toContain("if (!sentSessionId || sentSessionId === currentSessionId)");
  });
});