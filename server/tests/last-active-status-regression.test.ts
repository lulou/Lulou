import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { isActiveToday } from "../../client/src/lib/last-active";

describe("last active status", () => {
  const now = new Date("2026-04-15T12:00:00");
  const discover = readFileSync("client/src/pages/discover.tsx", "utf8");
  const likes = readFileSync("client/src/pages/likes.tsx", "utf8");
  const matches = readFileSync("client/src/pages/matches.tsx", "utf8");
  const messaging = readFileSync("client/src/pages/messaging.tsx", "utf8");
  const status = readFileSync("client/src/components/last-active-status.tsx", "utf8");
  const helper = readFileSync("client/src/lib/last-active.ts", "utf8");
  const storage = readFileSync("server/storage.ts", "utf8");

  it("shows only for an opted-in valid timestamp on the viewer's local day", () => {
    expect(isActiveToday("2026-04-15T00:01:00", true, now)).toBe(true);
    expect(isActiveToday("2026-04-14T23:59:00", true, now)).toBe(false);
    expect(isActiveToday("not-a-date", true, now)).toBe(false);
    expect(isActiveToday("2026-04-15T00:01:00", false, now)).toBe(false);
  });

  it("renders the shared status in each requested profile surface", () => {
    expect(discover).toContain("<LastActiveStatus");
    expect(likes).toContain("<LastActiveStatus");
    expect(matches).toContain("function ProfilePanel");
    expect(matches.slice(matches.indexOf("function ProfilePanel"), matches.indexOf("function ProfilePanel") + 7000))
      .toContain("<LastActiveStatus");
  });

  it("keeps raw timestamps private while retaining the preference", () => {
    expect(storage).toContain("showLastActive: _hasShowLastActiveColumn");
    expect(storage).toContain("lastActive: _hasLastActiveColumn && (row.show_last_active ?? true) && row.last_active");
    expect(storage).not.toContain("lastActive: _hasLastActiveColumn && row.last_active ?");
  });

  it("does not use viewer localStorage or legacy formatter for presence", () => {
    expect(matches).not.toContain("settings_show_last_active");
    expect(matches).not.toContain("formatLastActive");
    expect(messaging).not.toContain("settings_show_last_active");
    expect(messaging).not.toContain("formatLastActive");
  });

  it("does not retain exact, elapsed, or yesterday status strings", () => {
    for (const source of [helper, status, discover, likes, matches, messaging]) {
      expect(source).not.toMatch(/Active now|Active yesterday|Active \d+[mhd] ago|Active \d+d ago/);
    }
  });

  it("returns null before creating any hidden wrapper or spacing", () => {
    const hiddenBranch = status.slice(status.indexOf("if (!isActiveToday"), status.indexOf("return ("));
    expect(hiddenBranch).toContain("return null");
    expect(hiddenBranch).not.toContain("<span");
  });
});