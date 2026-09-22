import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("profile visual polish regressions", () => {
  const css = read("client/src/index.css");
  const infoRow = read("client/src/components/profile-info-row.tsx");
  const discover = read("client/src/pages/discover.tsx");
  const profile = read("client/src/pages/profile.tsx");
  const layout = read("client/src/components/app-layout.tsx");

  it("uses restrained premium weights for identity, metadata, and section hierarchy", () => {
    expect(css).toContain(".profile-identity-title");
    expect(css).toContain("font-weight: 700");
    expect(css).toContain(".profile-metadata-label");
    expect(css).toContain(".profile-metadata-value");
    expect(css).toContain("font-weight: 600");
    expect(css).toContain(".profile-section-label");
    expect(infoRow).toContain("profile-metadata-label");
    expect(infoRow).toContain("profile-metadata-value");
    expect(discover).toContain("profile-identity-title");
    expect(profile).toContain("profile-section-label");
  });

  it("keeps body copy unchanged rather than globally bolding the app", () => {
    expect(css).not.toMatch(/\bbody\s*\{[^}]*font-weight:\s*(?:600|700|bold)/s);
  });

  it("uses the exact outgoing voice-note wine fill on the Elevate button", () => {
    expect(css).toContain(".voice-note-outgoing { color: hsl(var(--primary-foreground)); background: hsl(var(--communication-wine))");
    expect(css).toContain(".communication-wine-fill");
    expect(css).toContain("background: hsl(var(--communication-wine))");
    expect(profile).toContain('className="communication-wine-fill shrink-0"');
  });

  it("allows long metadata values to wrap without horizontal overflow", () => {
    expect(infoRow).toContain("break-words");
  });

  it("strengthens Logout and Undo icons without changing their controls", () => {
    expect(layout).toContain('data-testid="button-header-logout"');
    expect(layout).toContain('className="w-4 h-4" strokeWidth={2.15}');
    expect(layout).toContain("text-foreground/75 hover:text-destructive");

    expect(discover).toContain('data-testid="button-undo-pass"');
    expect(discover).toContain("flex h-11 w-11");
    expect(discover).toContain("text-[hsl(var(--communication-wine))]");
    expect(discover).toContain("disabled:text-muted-foreground/70 disabled:opacity-60");
    expect(discover).toContain('className="h-[18px] w-[18px]" strokeWidth={2.15}');
    expect(discover).toContain('data-testid="button-discover-safety-menu"');
  });
});