import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("profile collapsing name header", () => {
  const source = readFileSync("client/src/pages/profile.tsx", "utf8");

  it("uses the real identity row and AppLayout scroll owner as the threshold", () => {
    expect(source).toContain("identityRowRef");
    expect(source).toContain('document.querySelector(\'[data-scroll-owner="app-layout-main"]\')');
    expect(source).toContain("new IntersectionObserver");
    expect(source).toContain("root: scrollOwner");
    expect(source).toContain('data-testid="profile-identity-row"');
  });

  it("keeps the expanded name primary and reveals only a conditional compact title", () => {
    expect(source).toContain('data-testid="text-profile-name"');
    expect(source).toContain('data-testid="text-profile-sticky-name"');
    expect(source).toContain('data-profile-sticky-name-state={identityInView ? "hidden" : "visible"}');
    expect(source).toContain('identityInView ? "opacity-0 -translate-y-2" : "opacity-100 translate-y-0"');
    expect(source).toContain('className="sticky top-0 z-30 h-0 pointer-events-none"');
    expect(source).toContain('env(safe-area-inset-top, 0px)');
  });

  it("preserves profile editing and settings controls", () => {
    expect(source).toContain('onClick={() => navigate("/settings")}');
    expect(source).toContain('data-testid="button-settings-icon"');
    expect(source).toContain('onClick={() => toggle("settings")}');
    expect(source).toContain('data-testid="button-edit-profile"');
  });
});