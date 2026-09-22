import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("client/src/index.css", "utf8");
const matches = readFileSync("client/src/pages/matches.tsx", "utf8");
const messaging = readFileSync("client/src/pages/messaging.tsx", "utf8");
const control = readFileSync("client/src/components/communication-control.tsx", "utf8");
const resolver = readFileSync("shared/communication-entitlements.ts", "utf8");

describe("communication visual state regressions", () => {
  it("keeps the outgoing voice-note wine as the shared fill source", () => {
    expect(styles).toContain("--communication-wine: 350 35% 43%");
    expect(styles).toContain(".voice-note-outgoing { color: hsl(var(--primary-foreground)); background: hsl(var(--communication-wine))");
    expect(styles).toContain(".outgoing-message,");
    expect(matches).toContain('? "outgoing-message px-4 py-3"');
    expect(messaging).toContain('? "outgoing-message px-3 py-2"');
  });

  it("uses the same wine fill for Plan a Date and related meet CTAs", () => {
    const matchPlanDate = matches.slice(
      matches.indexOf('data-testid={`date-plan-choice-'),
      matches.indexOf("callStage === 0 && rawLimitReached"),
    );
    const messagingPlanDate = messaging.slice(
      messaging.indexOf('data-testid="button-plan-date"') - 200,
      messaging.indexOf('data-testid="button-plan-date"') + 200,
    );
    expect(matchPlanDate).toContain("communication-wine-fill");
    expect(messagingPlanDate).toContain("communication-wine-fill");
  });

  it("keeps Call, Mic, and Video visible in both top communication rows", () => {
    for (const source of [matches, messaging]) {
      const row = source.slice(
        source.indexOf('data-ui-version="communication-controls-106"') - 300,
        source.indexOf('data-ui-version="communication-controls-106"') + 4000,
      );
      expect(row).toContain("button-phone-tray");
      expect(row).toContain("button-mic-tray");
      expect(row).toContain("button-video-tray");
      expect(row).toContain('allCallsDone && voiceNotesUnlocked ? "used_paid"');
    }
    expect(control).toContain('used_paid: {');
    expect(control).toContain('color: "hsl(350 42% 36%)"');
  });

  it("requires both paid entitlement and stage eligibility before Video is green", () => {
    expect(resolver).toContain("videoCredits > 0");
    expect(resolver).toContain("paidVideoConsumed");
    expect(resolver).toContain('reason: "purchase_required"');
    expect(resolver).toContain("videoStageGate.state === \"locked\"");
    for (const source of [matches, messaging]) {
      expect(source).toContain("gate.purchaseRequired");
      expect(source).toContain('setPurchasePromptFeature("video")');
      expect(source).toContain('if (gate.state === "available")');
      expect(source).toContain("startPaidCall.mutate({ isVideo: true })");
      expect(source).toContain('lastCallMediaType === "video"');
      expect(source).toContain("lastCallIsPaid === true");
    }
    expect(control).toContain("color: COMMUNICATION_ACTIVE_GREEN");
  });
});