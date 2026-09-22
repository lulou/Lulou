import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("profile visual polish regressions", () => {
  const css = read("client/src/index.css");
  const infoRow = read("client/src/components/profile-info-row.tsx");
  const discover = read("client/src/pages/discover.tsx");
  const profile = read("client/src/pages/profile.tsx");
  const settings = read("client/src/pages/settings.tsx");
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

  it("uses the voice-note wine token for primary Profile and Settings controls", () => {
    expect(css).toMatch(/\.settings-primary-switch\[data-state="checked"\]\s*\{[^}]*background:\s*hsl\(var\(--communication-wine\)\)/s);
    expect(settings).toContain('className="settings-primary-switch"');
    expect(profile).toContain('? "communication-wine-fill border-transparent shadow-sm"');
    expect(profile).toContain('className="communication-wine-fill w-full"');
    expect(profile).toContain('data-testid="button-save-starters"');
    expect(profile).toContain('data-testid="button-save-questions"');
    expect(settings).toContain('communication-wine-fill py-3 px-3 rounded-2xl');
    expect(settings).not.toContain('rounded-2xl bg-primary text-primary-foreground text-sm font-semibold');
    expect(css).toContain("--destructive: 0 60% 48%");
  });

  it("allows long metadata values to wrap without horizontal overflow", () => {
    expect(infoRow).toContain("break-words");
  });

  it("uses semibold prompt-card copy and a fully opaque Discover toolbar", () => {
    expect(css).toContain(".profile-prompt-card");
    expect(css).toMatch(/\.profile-prompt-card\s*\{[^}]*font-weight:\s*600/s);
    expect(discover).toContain("profile-prompt-card rounded-md");
    expect(discover).toContain('className="sticky z-40 bg-background border-b px-5 py-3"');
    expect(discover).toContain('className="pointer-events-none absolute inset-x-0 bottom-full bg-background"');
    expect(discover).not.toContain("sticky z-40 bg-background/95 backdrop-blur-sm");
  });

  it("strengthens Logout and Undo icons without changing their controls", () => {
    expect(layout).toContain('data-testid="button-header-logout"');
    expect(layout).toContain('className="w-4 h-4" strokeWidth={2.15}');
    expect(layout).toContain("text-[hsl(20_18%_22%)] hover:text-destructive");

    expect(discover).toContain('data-testid="button-undo-pass"');
    expect(discover).toContain("flex h-11 w-11");
    expect(discover).toContain('color: "hsl(350 35% 14%)"');
    expect(discover).toContain('color: "hsl(20 12% 28%)"');
    expect(discover).not.toContain("disabled:opacity-70");
    expect(discover).toContain('className="h-[18px] w-[18px]" strokeWidth={2.15}');
    expect(discover).toContain('data-testid="button-discover-safety-menu"');
    expect(discover).toContain('className="h-5 w-5" strokeWidth={2.15}');
  });
});