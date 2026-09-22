import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("profile visual polish regressions", () => {
  const css = read("client/src/index.css");
  const infoRow = read("client/src/components/profile-info-row.tsx");
  const discover = read("client/src/pages/discover.tsx");
  const profile = read("client/src/pages/profile.tsx");

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
});