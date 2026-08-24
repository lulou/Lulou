import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveWheelDismissal } from "../../client/src/lib/wheel-presentation-guard";
import { canStartHaloSend, SPIN_ROOM_TIMING } from "../../client/src/lib/spin-room-timing";

describe("production Discover and Wheel regressions", () => {
  it("keeps Discover in the shell's single shrinkable vertical scroll region", () => {
    const appLayout = readFileSync("client/src/components/app-layout.tsx", "utf8");

    expect(appLayout).toContain('"flex-1 min-h-0 overflow-y-auto flex flex-col"');
    expect(appLayout).toContain("isScrollWithHeaderPage && appHeader");
    expect(appLayout).toContain("!isChatRoom && <nav");
  });

  it("keeps the measured winner handoff while removing excess post-lock delay", () => {
    expect(SPIN_ROOM_TIMING.firstMessageMs).toBe(1_300);
    expect(SPIN_ROOM_TIMING.finalMessageMs).toBe(2_600);
    expect(SPIN_ROOM_TIMING.growStartMs).toBe(4_300);
    expect(SPIN_ROOM_TIMING.resultHandoffMs).toBe(8_200);
    expect(SPIN_ROOM_TIMING.resultHandoffMs).toBeGreaterThanOrEqual(
      SPIN_ROOM_TIMING.growStartMs + SPIN_ROOM_TIMING.growDurationMs,
    );
    expect(SPIN_ROOM_TIMING.controlsDelayMs).toBe(700);
    expect(SPIN_ROOM_TIMING.resultHandoffMs).toBeLessThan(12_100);
  });

  it("allows exactly one active Halo send and preserves failed-send retry", () => {
    expect(canStartHaloSend({
      hasWinner: true,
      haloSent: false,
      mutationPending: false,
      inFlight: false,
    })).toBe(true);

    expect(canStartHaloSend({
      hasWinner: true,
      haloSent: false,
      mutationPending: true,
      inFlight: true,
    })).toBe(false);

    expect(canStartHaloSend({
      hasWinner: true,
      haloSent: false,
      mutationPending: false,
      inFlight: false,
    })).toBe(true);
  });

  it("uses the persistence-aware completion path after Halo acknowledgement", () => {
    const intent = readFileSync("client/src/pages/intent.tsx", "utf8");

    expect(intent).toContain("closeProfileRef.current?.()");
    expect(intent).toContain("SPIN_ROOM_TIMING.haloAcknowledgementMs");
    expect(intent).toContain("spinRoomOut 0.26s");
    expect(intent).not.toContain("window.setTimeout(() => setShowSpinExtras(true), 420)");
    expect(resolveWheelDismissal(true).releasePresentation).toBe(true);
    expect(resolveWheelDismissal(false).reopenResult).toBe(true);
  });
});