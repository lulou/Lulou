import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const matchesPage = readFileSync("client/src/pages/matches.tsx", "utf8");
const routes = readFileSync("server/routes.ts", "utf8");

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

  it("keeps the selected option visible after the backend confirms the save", () => {
    const mutationSuccess = matchesPage.slice(
      matchesPage.indexOf("onSuccess: (data: any, selection) =>"),
      matchesPage.indexOf("onError: (err: any, selection) =>"),
    );

    expect(mutationSuccess).not.toContain("setShowAvailPicker(false)");
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
  });
});