import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("communication control state styling", () => {
  it("uses one green active palette and glow for every renderer", () => {
    const control = readFileSync("client/src/components/communication-control.tsx", "utf8");
    const messaging = readFileSync("client/src/pages/messaging.tsx", "utf8");
    const matches = readFileSync("client/src/pages/matches.tsx", "utf8");

    expect(control).toContain('COMMUNICATION_ACTIVE_GREEN = "#3B8F68"');
    expect(control).toContain('color: COMMUNICATION_ACTIVE_GREEN');
    expect(control).toContain("filter: COMMUNICATION_ACTIVE_GLOW");
    expect(control).toContain('state === "available" || state === "recording"');

    for (const source of [messaging, matches]) {
      expect(source).toContain("getCommunicationStateStyle");
      expect(source).toContain("getCommunicationIconStyle");
      expect(source).toContain("communicationEntitlements.audio.state");
      expect(source).toContain("communicationEntitlements.video.state");
      expect(source).toContain("voiceNotesUnlocked ? \"available\" : \"locked\"");
      expect(source).not.toContain("WINE_CALL_COLOR");
    }
  });

  it("keeps locked taupe and paid wine states free from the active glow", () => {
    const control = readFileSync("client/src/components/communication-control.tsx", "utf8");

    expect(control).toContain('color: "hsl(32 12% 42%)"');
    expect(control).toContain('color: "hsl(350 42% 36%)"');
    expect(control).toContain('return state === "available" || state === "recording"');
    expect(control).toContain(": undefined;");
  });
});