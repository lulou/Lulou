import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getUsableProfilePhotos,
  isUsableProfilePhotoUrl,
} from "../../shared/profile-photo-quality";

const discoverPage = readFileSync("client/src/pages/discover.tsx", "utf8");
const intentPage = readFileSync("client/src/pages/intent.tsx", "utf8");
const globalCss = readFileSync("client/src/index.css", "utf8");
const routes = readFileSync("server/routes.ts", "utf8");

describe("Discover empty-state logo pulse", () => {
  it("animates the complete logo treatment and respects reduced motion", () => {
    expect(discoverPage).toContain(
      'className="discover-empty-logo-pulse w-16 h-16 rounded-full',
    );
    expect(globalCss).toContain("@keyframes discoverEmptyLogoBreath");
    expect(globalCss).toContain("animation: discoverEmptyLogoBreath 2.6s ease-in-out infinite");
    expect(globalCss).toMatch(
      /prefers-reduced-motion[\s\S]*\.discover-empty-logo-pulse \{ animation: none; \}/,
    );
  });
});

describe("Intention Wheel profile photo quality", () => {
  it("rejects empty, placeholder, app artwork, and unsupported image values", () => {
    expect(isUsableProfilePhotoUrl("")).toBe(false);
    expect(isUsableProfilePhotoUrl("/lulou-logo-master.png")).toBe(false);
    expect(isUsableProfilePhotoUrl("https://cdn.example.com/default-avatar.svg")).toBe(false);
    expect(isUsableProfilePhotoUrl("data:image/heic;base64,abc")).toBe(false);
    expect(isUsableProfilePhotoUrl("https://cdn.example.com/profile.jpg")).toBe(true);
  });

  it("preserves canonical order while removing invalid and duplicate photos", () => {
    expect(getUsableProfilePhotos([
      " https://cdn.example.com/primary.jpg ",
      "https://cdn.example.com/placeholder.png",
      "https://cdn.example.com/primary.jpg",
      "https://cdn.example.com/secondary.webp",
    ])).toEqual([
      "https://cdn.example.com/primary.jpg",
      "https://cdn.example.com/secondary.webp",
    ]);
  });

  it("validates candidates before assignment and advances on image failure", () => {
    expect(routes).toContain("await storage.getUserIdsWithUsableProfilePhotos");
    expect(routes).toContain(".filter(profile => photoEligibleUserIds.has(profile.userId))");
    expect(routes).toContain("isExplicitlyIneligibleWheelProfile");
    expect(intentPage).toContain("setPhotoIndex(index => index + 1)");
    expect(intentPage).toContain("setPhotoIndex(current => current + 1)");
  });
});