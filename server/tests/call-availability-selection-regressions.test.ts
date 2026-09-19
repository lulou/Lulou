import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const matchesPage = readFileSync("client/src/pages/matches.tsx", "utf8");
const routes = readFileSync("server/routes.ts", "utf8");
const storage = readFileSync("server/storage.ts", "utf8");
const signaling = readFileSync("client/src/hooks/use-call-signaling.ts", "utf8");
const availabilityVersion = readFileSync("client/src/lib/call-availability-version.ts", "utf8");
const atomicAvailabilityMigration = readFileSync("supabase/migrations/add_atomic_call_availability.sql", "utf8");
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
    expect(callReadySection).toContain("startCall.mutate({ isVideo: false, diagId, clickedAt })");
  });

  it("keeps active-state detection but delegates call UI to the global overlay", () => {
    const activeState = matchesPage.slice(
      matchesPage.indexOf("const isCallActive ="),
      matchesPage.indexOf("if (detail.callStartedAt)"),
    );

    expect(activeState).toContain("detail.callAnswered === true");
    expect(activeState).toContain("!detail.callCompleted");
    expect(activeState).toContain("!!detail.callSessionId");
    expect(matchesPage).toContain("false && isCallActive ? (");
  });

  it("keeps the specific-time option selected and reverts only on cancel or save failure", () => {
    expect(matchesPage).toContain('setSelectedAvailability(opt.key)');
    expect(matchesPage).toContain('key: "specific_time"');
    expect(matchesPage).toContain(
      "setSelectedAvailability(availabilityBeforeSpecificRef.current)",
    );
    expect(matchesPage).toContain("setSelectedAvailability(selection.previousKey)");
  });

  it("uses the approved active-call green treatment for only the selected option", () => {
    expect(matchesPage).toContain("selectedAvailability === opt.key");
    expect(matchesPage).toContain(
      "border-green-600 bg-green-50 text-green-700",
    );
    expect(matchesPage).toContain("bg-green-600 text-white");
  });

  it("keeps the availability controls above overlays with real touch-sized buttons", () => {
    const picker = matchesPage.slice(
      matchesPage.indexOf("/* ── Step 2: Pick your availability slot"),
      matchesPage.indexOf("/* ── Step 3: Waiting for the other user"),
    );
    expect(picker).toContain('<button');
    expect(picker).toContain('type="button"');
    expect(picker).toContain("min-h-11");
    expect(picker).toContain("touch-manipulation");
    expect(matchesPage).toContain('callStageState === "CHOOSING_AVAILABILITY" || showAvailPicker');
    expect(matchesPage).toContain('? "none"');
  });

  it("persists through the existing absolute timestamp schema", () => {
    expect(routes).toContain(
      "availableAt must be a valid ISO timestamp not more than 5 minutes in the past",
    );
    expect(routes).toContain(
      "await storage.setCallAvailability(matchId, userId, availableAt ?? null)",
    );
    expect(availabilityWrite).toContain('this.sb.rpc("set_call_availability_atomic"');
  });

  it("applies availability through the global call realtime channel", () => {
    expect(routes).toContain('type: "call:availability"');
    expect(routes).toContain("await broadcastCallEvent(matchId");
    expect(routes).toContain("serverBroadcastAt");
    expect(signaling).toContain('event.type === "call:availability"');
    expect(signaling).toContain("availability_realtime_ms");
    expect(signaling).toContain("acceptAvailabilityVersion");
    expect(availabilityVersion).toContain("latestAvailabilityVersionByMatch");
    expect(signaling).toContain('queryClient.invalidateQueries({ queryKey: ["/api/matches", matchId] })');
  });

  it("prevents stale agreement calculations from overwriting concurrent updates", () => {
    expect(availabilityWrite).toContain('this.sb.rpc("set_call_availability_atomic"');
    expect(storage).toContain('this.sb.rpc("expire_call_availability_atomic"');
  });

  it("binds atomic availability RPCs to the authenticated user", () => {
    expect(atomicAvailabilityMigration).toContain("p_user_id IS DISTINCT FROM auth.uid()::TEXT");
  });

  it("binds call creation and expiry clearing to the validated agreement", () => {
    expect(storage).toContain('callStartWrite.eq("agreed_call_at", expectedAgreedCallAt)');
    expect(storage).toContain('callStartWrite.eq("availability_revision", expectedAvailabilityRevision)');
    expect(routes).toContain("expectedAvailabilityRevision,");
    expect(routes).toContain("clearAgreedCallAt(matchId, userId, agreed.toISOString())");
  });

  it("shows immediate Start Call progress and actionable server errors", () => {
    expect(matchesPage).toContain("startCall.isPending");
    expect(matchesPage).toContain('t("calling_name").replace("{name}", match.profile.firstName)');
    expect(matchesPage).toContain('error.message.includes("availability_expired")');
    expect(matchesPage).toContain('error.message.includes("Availability changed")');
    expect(matchesPage).toContain("call_create_ms");
    expect(matchesPage).toContain("wakeAtBoundaries");
  });
});