import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const matchesPage = readFileSync("client/src/pages/matches.tsx", "utf8");
const routes = readFileSync("server/routes.ts", "utf8");
const storage = readFileSync("server/storage.ts", "utf8");
const availabilityMutation = matchesPage.slice(
  matchesPage.indexOf("const setCallAvailMutation"),
  matchesPage.indexOf("const startPaidCall"),
);
const availabilityWrite = storage.slice(
  storage.indexOf("async setCallAvailability("),
  storage.indexOf("async clearAgreedCallAt("),
);

describe("call availability selection regressions", () => {
  it("uses one canonical key for every availability option", () => {
    for (const key of [
      "available_now",
      "in_30_minutes",
      "in_1_hour",
      "in_2_hours",
      "specific_time",
    ]) {
      expect(matchesPage).toContain(`{ key: "${key}"`);
    }
  });

  it("selects Available now locally before persisting its absolute timestamp", () => {
    const optionHandler = matchesPage.slice(
      matchesPage.indexOf("const previousKey = selectedAvailability"),
      matchesPage.indexOf("aria-pressed={selectedAvailability === opt.key}"),
    );

    expect(optionHandler.indexOf("setSelectedAvailability(opt.key)")).toBeGreaterThan(-1);
    expect(optionHandler.indexOf("setCallAvailMutation.mutate({")).toBeGreaterThan(
      optionHandler.indexOf("setSelectedAvailability(opt.key)"),
    );
    expect(optionHandler).toContain("setShowAvailPicker(true)");
    expect(optionHandler).toContain("availableAt: toAbsoluteTimestamp(opt.key)");
    expect(matchesPage).toContain("available_now:   0");
  });

  it("moves from the picker to the server-backed call status after the save", () => {
    const mutationSuccess = availabilityMutation.slice(
      availabilityMutation.indexOf("onSuccess: (data: any, selection) =>"),
      availabilityMutation.indexOf("onError: (err: any, selection) =>"),
    );

    expect(mutationSuccess).toContain("setShowAvailPicker(false)");
  });

  it("never starts a call from an availability save", () => {
    const mutationSuccess = availabilityMutation.slice(
      availabilityMutation.indexOf("onSuccess: (data: any, selection) =>"),
      availabilityMutation.indexOf("onError: (err: any, selection) =>"),
    );

    expect(mutationSuccess).not.toContain("startCall.mutate");
    expect(mutationSuccess).not.toContain("armCallSession");
  });

  it("requires the explicit call-ready button to start the first call", () => {
    const callReadySection = matchesPage.slice(
      matchesPage.indexOf("/* ── Step 4: Both ready — Start Call unlocked"),
      matchesPage.indexOf("/* ── Composer", matchesPage.indexOf("/* ── Step 4: Both ready — Start Call unlocked")),
    );

    expect(callReadySection).toContain("button-start-call-ready-");
    expect(callReadySection).toContain("startCall.mutate({ isVideo: false })");
  });

  it("shows First call in progress only for an answered active session", () => {
    const activeState = matchesPage.slice(
      matchesPage.indexOf("const isCallActive ="),
      matchesPage.indexOf("if (detail.callStartedAt)"),
    );
    const activeBanner = matchesPage.slice(
      matchesPage.indexOf(") : isCallActive ? ("),
      matchesPage.indexOf(") : callStage === 0", matchesPage.indexOf(") : isCallActive ? (")),
    );

    expect(activeState).toContain("detail.callAnswered === true");
    expect(activeState).toContain("!detail.callCompleted");
    expect(activeState).toContain("!!detail.callSessionId");
    expect(activeBanner).toContain('t("first_call_in_progress")');
  });

  it("keeps the specific-time option selected and reverts only on cancel or save failure", () => {
    expect(matchesPage).toContain('setSelectedAvailability(opt.key)');
    expect(matchesPage).toContain('key: "specific_time"');
    expect(matchesPage).toContain(
      "setSelectedAvailability(availabilityBeforeSpecificRef.current)",
    );
    expect(matchesPage).toContain("setSelectedAvailability(selection.previousKey)");
  });

  it("uses Lulou primary tokens for only the selected option", () => {
    expect(matchesPage).toContain("selectedAvailability === opt.key");
    expect(matchesPage).toContain(
      "border-primary/60 bg-primary/10 text-primary",
    );
    expect(matchesPage).toContain("hsl(var(--primary)/0.16)");
  });

  it("persists through the existing absolute timestamp schema", () => {
    expect(routes).toContain(
      "availableAt must be a valid ISO timestamp not more than 5 minutes in the past",
    );
    expect(routes).toContain(
      "await storage.setCallAvailability(matchId, userId, availableAt ?? null)",
    );
    expect(availabilityWrite).toContain("ownUpdate.call_avail_1_at");
    expect(availabilityWrite).toContain("ownUpdate.call_avail_2_at");
    expect(availabilityWrite).not.toMatch(/ownUpdate\.call_avail_1(?!_at)/);
    expect(availabilityWrite).not.toMatch(/ownUpdate\.call_avail_2(?!_at)/);
  });
});