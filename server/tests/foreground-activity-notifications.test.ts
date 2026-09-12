import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const routes = readFileSync("server/routes.ts", "utf8");
const pushService = readFileSync("server/pushService.ts", "utf8");
const appLayout = readFileSync("client/src/components/app-layout.tsx", "utf8");

describe("foreground activity notification policy", () => {
  it("uses a numeric database age when deciding whether the app is active", () => {
    const activeAppCheck = pushService.slice(
      pushService.indexOf("export async function isUserActiveInApp"),
      pushService.indexOf("export async function isUserActiveInChat"),
    );
    expect(activeAppCheck).toContain("EXTRACT(EPOCH FROM (NOW() - last_seen_at))");
    expect(activeAppCheck).toContain("Number(row.age_seconds)");
    expect(activeAppCheck).not.toContain('String(row.age ?? "")');
  });

  it("suppresses foreground message notifications while retaining background push", () => {
    expect(routes).toContain("else if (activeInApp)");
    expect(routes).toContain("SUPPRESSED — recipient active elsewhere in app");
    expect(routes).toContain("SENDING push — recipient inactive");
  });

  it("suppresses foreground Like and match pushes", () => {
    expect(routes).toContain("const recipientActive = await isUserActiveInApp(toUserId)");
    expect(routes).toContain("SUPPRESSED foreground Like push");
    expect(routes).toContain("const [fromActive, toActive]");
  });

  it("keeps authoritative app-shell badge subscriptions and positioning", () => {
    expect(appLayout).toContain('channel(`unread:${user.id}`)');
    expect(appLayout).toContain('channel(`nav-interest:${user.id}`)');
    expect(appLayout).toContain('data-testid="badge-connections-count"');
    expect(appLayout).toContain('data-testid="badge-likes-count"');
    expect(appLayout).toContain("absolute -top-1.5 -right-3.5");
  });
});