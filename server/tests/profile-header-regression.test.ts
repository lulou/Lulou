import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("profile collapsing name header", () => {
  const source = readFileSync("client/src/pages/profile.tsx", "utf8");
  const discover = readFileSync("client/src/pages/discover.tsx", "utf8");

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

  it("applies the same measured behavior to the production Discover profile renderer", () => {
    expect(discover).toContain("discoverHeaderSentinelRef");
    expect(discover).toContain("discoverToolbarRef");
    expect(discover).toContain('data-testid="discover-header-collapse-sentinel"');
    expect(discover).toContain('data-testid="discover-profile-identity"');
    expect(discover).toContain('document.querySelector(\'[data-scroll-owner="app-layout-main"]\')');
    expect(discover).toContain("const coveredTop = stickyTop + toolbar.getBoundingClientRect().height");
    expect(discover).toContain('rootMargin: `-${coveredTop}px 0px 0px 0px`');
    expect(discover).toContain("entry.boundingClientRect.top <= boundaryTop + 1");
    expect(discover).toContain('data-discover-sticky-name-state={isIdentityCollapsed ? "visible" : "hidden"}');
    expect(discover).toContain('className="sticky z-40 bg-background/95 backdrop-blur-sm border-b px-5 py-3"');
    expect(discover).toContain('style={{ top: "env(safe-area-inset-top, 0px)" }}');
    expect(discover).toContain('style={{ height: "env(safe-area-inset-top, 0px)" }}');
    expect(discover).not.toContain("sticky top-0 z-30 h-0");
    expect(discover).toContain('data-testid="text-discover-expanded-name"');
    expect(discover).toContain(': "invisible opacity-0 -translate-y-2"');
  });

  it("keeps Discover controls and coordinates expanded and compact header names", () => {
    expect(discover).toContain('data-testid="button-undo-pass"');
    expect(discover).toContain('data-testid="button-discover-safety-menu"');
    expect(discover).toContain('className="relative max-w-md mx-auto flex items-center justify-between"');
    expect(discover.match(/data-testid="text-discover-expanded-name"/g)).toHaveLength(1);
    expect(discover.match(/data-testid="text-discover-sticky-name"/g)).toHaveLength(1);
    expect(discover).toContain('aria-hidden={isIdentityCollapsed}');
    expect(discover).toContain('aria-hidden={!isIdentityCollapsed}');
  });
});