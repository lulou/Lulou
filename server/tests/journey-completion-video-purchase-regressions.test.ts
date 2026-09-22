import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("journey completion and locked video regressions", () => {
  const routes = read("server/routes.ts");
  const storage = read("server/storage.ts");
  const schema = read("shared/schema.ts");
  const realtime = read("client/src/hooks/use-realtime-messages.ts");
  const messaging = read("client/src/pages/messaging.tsx");
  const matches = read("client/src/pages/matches.tsx");
  const purchasePrompt = read("client/src/components/purchase-prompt.tsx");
  const purchaseService = read("client/src/lib/purchase-service.ts");
  const journeyComponent = read("client/src/components/journey-completion-experience.tsx");
  const i18n = read("client/src/lib/i18n.ts");

  it("requires the final stage and both persisted number flags", () => {
    expect(routes.match(/Number\(match\.callStage \?\? 0\) >= 4/g)?.length).toBeGreaterThanOrEqual(2);
    expect(routes).toContain("match.numberExchanged1 === true");
    expect(routes).toContain("match.numberExchanged2 === true");
    expect(storage).toContain("number_exchanged_1, number_exchanged_2");
  });

  it("persists one acknowledgement per user and match", () => {
    expect(schema).toContain('pgTable("journey_completion_acknowledgements"');
    expect(schema).toContain("primaryKey({ columns: [table.matchId, table.userId] })");
    expect(routes).toContain("/journey-completion/acknowledge");
    expect(routes).toContain(".onConflictDoNothing()");
  });

  it("broadcasts and applies both number flags in realtime", () => {
    expect(routes).toContain('"number-exchange"');
    expect(realtime).toContain('{ event: "number-exchange" }');
    expect(realtime).toContain("numberExchanged1: payload.numberExchanged1 === true");
    expect(realtime).toContain("numberExchanged2: payload.numberExchanged2 === true");
  });

  it("uses one shared completion experience on both chat surfaces", () => {
    expect(messaging).toContain("<JourneyCompletionExperience");
    expect(matches).toContain("<JourneyCompletionExperience");
    expect(i18n).toContain("Your journey together on Lulou is complete.");
    expect(journeyComponent).toContain('["Match", "Chat", "1st Call", "Meet"]');
  });

  it("opens the video purchase prompt for every locked video state", () => {
    const unconditionalBranch = /if \(gate\.state === "locked"\) \{\s+if \(isVideo\) \{\s+setPurchasePromptFeature\("video"\)/;
    expect(messaging).toMatch(unconditionalBranch);
    expect(matches).toMatch(unconditionalBranch);
  });

  it("shows only the canonical $6.99 AUD one-credit starter pack", () => {
    expect(purchasePrompt).toContain('name: "Video Call Starter Pack"');
    expect(purchasePrompt).toContain('detail: "1 video-call credit"');
    expect(purchasePrompt).toContain('price: "$6.99 AUD"');
    expect(purchasePrompt).toContain('packs: [VIDEO_PACKS[0]]');
    expect(purchasePrompt).toContain("Unlock Video Call — $6.99");
    expect(purchasePrompt).toContain('subtitle: "Take your connection face-to-face."');
    expect(purchasePrompt).toContain('data-testid="button-not-now"');
  });

  it("resets the pending checkout state after an iPhone bfcache return", () => {
    expect(purchasePrompt).toContain('window.addEventListener("pageshow", handlePageShow)');
    expect(purchasePrompt).toContain("if (event.persisted) setLoading(null)");
  });

  it("reports the Stripe paused state without granting a credit", () => {
    expect(purchaseService).toContain('parsed?.code === "stripe_live_charges_disabled"');
    expect(purchaseService).toContain("No charge or credit was created.");
  });
});