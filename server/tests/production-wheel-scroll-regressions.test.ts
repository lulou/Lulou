import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveWheelDismissal } from "../../client/src/lib/wheel-presentation-guard";
import { canStartHaloSend, SPIN_ROOM_TIMING } from "../../client/src/lib/spin-room-timing";
import { shouldPreventPhotoTouchMove } from "../../client/src/lib/photo-gesture";
import { getIdleWheelVisibleIndices } from "../../client/src/lib/wheel-idle-presentation";

describe("production Discover and Wheel regressions", () => {
  it("keeps Discover in the shell's single shrinkable vertical scroll region", () => {
    const appLayout = readFileSync("client/src/components/app-layout.tsx", "utf8");

    expect(appLayout).toContain('"flex-1 min-h-0 overflow-y-auto flex flex-col"');
    expect(appLayout).toContain("isScrollWithHeaderPage && appHeader");
    expect(appLayout).toContain("!isChatRoom && <nav");
  });

  it("does not let a late-mounted photo viewer cancel a page swipe", () => {
    expect(shouldPreventPhotoTouchMove({
      pointerId: null,
      dirLocked: null,
      startX: 0,
      startY: 0,
    }, { clientX: 240, clientY: 80 })).toBe(false);

    expect(shouldPreventPhotoTouchMove({
      pointerId: 7,
      dirLocked: null,
      startX: 120,
      startY: 420,
    }, { clientX: 124, clientY: 300 })).toBe(false);
  });

  it("preserves horizontal photo swipes only for an active horizontal gesture", () => {
    expect(shouldPreventPhotoTouchMove({
      pointerId: 7,
      dirLocked: null,
      startX: 120,
      startY: 420,
    }, { clientX: 220, clientY: 424 })).toBe(true);

    expect(shouldPreventPhotoTouchMove({
      pointerId: 7,
      dirLocked: true,
      startX: 120,
      startY: 420,
    }, { clientX: 130, clientY: 422 })).toBe(true);

    expect(shouldPreventPhotoTouchMove({
      pointerId: 7,
      dirLocked: false,
      startX: 120,
      startY: 420,
    }, { clientX: 220, clientY: 424 })).toBe(false);
  });

  it("keeps the full Wheel pool mounted while showing only three idle cards", () => {
    expect(getIdleWheelVisibleIndices(7)).toEqual([0, 1, 2]);
  });

  it("clips the dedicated Wheel stage horizontally without changing page-wide overflow", () => {
    const intent = readFileSync("client/src/pages/intent.tsx", "utf8");

    expect(intent).toContain("overflow-y-auto overflow-x-hidden");
    expect(intent).toContain("items.map((profile, i)");
    expect(intent).not.toContain("items.slice(0, 3).map");
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

  it("keeps Open on the active photo while Close floats at profile level", () => {
    const discover = readFileSync("client/src/pages/discover.tsx", "utf8");
    const photoViewer = readFileSync("client/src/components/profile-photo-viewer.tsx", "utf8");
    const storage = readFileSync("server/storage.ts", "utf8");
    const routes = readFileSync("server/routes.ts", "utf8");
    const migration = readFileSync("supabase/migrations/add_discover_safety_actions.sql", "utf8");

    expect(discover).toContain("Open");
    expect(discover).not.toContain("Send Halo");
    expect(discover).toContain('data-testid="button-close-profile-floating"');
    expect(discover).toContain('className="fixed z-40');
    expect(discover).not.toContain("leftAction=");
    expect(discover).toContain('data-testid="button-discover-safety-menu"');
    expect(discover).toContain('"/api/discover/remove-profile"');
    expect(discover).toContain('"/api/discover/block-profile"');
    expect(photoViewer).toContain("currentAction");
    expect(photoViewer).not.toContain("leftAction");
    expect(photoViewer).not.toContain("currentLeftAction");
    expect(routes).toContain('type: "remove" | "block"');
    expect(routes).toContain('app.post("/api/discover/block-profile"');
    expect(storage).toContain('.eq("type", "block")');
    expect(storage).toContain("blockedUserIds");
    expect(storage).toContain("async getIncomingOpens");
    expect(migration).toContain("interactions_discover_safety_actions_unique");
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