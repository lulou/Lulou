import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panel = readFileSync("client/src/components/meet-availability-state.tsx", "utf8");
const matches = readFileSync("client/src/pages/matches.tsx", "utf8");
const messaging = readFileSync("client/src/pages/messaging.tsx", "utf8");
const hook = readFileSync("client/src/hooks/use-realtime-messages.ts", "utf8");
const routes = readFileSync("server/routes.ts", "utf8");
const storage = readFileSync("server/storage.ts", "utf8");

describe("post-call meet availability agreement regressions", () => {
  it("shows Accept and Choose another time only in the other-only state", () => {
    const otherOnly = panel.slice(
      panel.indexOf('resolution.state === "other_only"'),
      panel.indexOf('resolution.state === "both_match"'),
    );
    expect(otherOnly).toContain("button-accept-meet-availability");
    expect(otherOnly).toContain("button-choose-another-meet-availability");
    expect(otherOnly).not.toContain("button-ready-to-meet");
  });

  it("does not use generic Ready to Meet copy before agreement", () => {
    expect(panel).not.toContain('t("ready_to_meet")');
    expect(messaging).toContain('headerMeetAvailability?.state === "both_match"');
    expect(messaging).toContain('? t("status_ready_to_meet")');
  });

  it("uses the same authoritative resolver and panel in both production chat surfaces", () => {
    for (const source of [matches, messaging]) {
      expect(source).toContain("resolveMeetAvailability(myAvailability, theirAvailability)");
      expect(source).toContain("<MeetAvailabilityStatePanel");
      expect(source).toContain("/meet-availability/accept");
      expect(source).toContain("expectedOtherAvailability: theirAvailability");
    }
  });

  it("labels mismatched times to the correct participant", () => {
    const mismatch = panel.slice(
      panel.indexOf('resolution.state === "both_mismatch"'),
      panel.indexOf('resolution.state === "self_only"'),
    );
    expect(mismatch).toContain('t("your_availability_lbl")');
    expect(mismatch).toContain('t("their_availability_lbl").replace("{name}", otherName)');
    expect(mismatch).toContain("resolution.selfAvailability");
    expect(mismatch).toContain("resolution.otherAvailability");
  });

  it("copies the persisted counterpart value with a conditional stale-write guard", () => {
    expect(storage).toContain("async acceptMeetAvailability(");
    expect(storage).toContain(".update({ [myColumn]: decision.copiedAvailability })");
    expect(storage).toContain(".is(myColumn, null)");
    expect(storage).toContain(".eq(otherColumn, decision.copiedAvailability)");
    expect(routes).toContain('"/api/matches/:matchId/meet-availability/accept"');
    expect(routes).toContain('status(409)');
  });

  it("broadcasts every save and accept over the existing chat channel", () => {
    expect(routes.split('`chat:${matchId}`, "meet-availability"').length - 1).toBe(2);
    expect(hook).toContain('.on("broadcast", { event: "meet-availability" }');
    expect(hook).toContain("meetAvailability1: payload.meetAvailability1 ?? null");
    expect(hook).toContain("meetAvailability2: payload.meetAvailability2 ?? null");
  });
});