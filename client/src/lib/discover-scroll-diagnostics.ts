import { useEffect, useRef, type RefObject } from "react";
import { API_BASE } from "@/lib/queryClient";
import {
  DISCOVER_SCROLL_CHECKPOINTS,
  isDiscoverScrollStuck,
  type DiscoverScrollCheckpoint,
} from "./discover-scroll-diagnostic-rules";

export {
  DISCOVER_SCROLL_CHECKPOINTS,
  isDiscoverScrollStuck,
  type DiscoverScrollCheckpoint,
} from "./discover-scroll-diagnostic-rules";

type ElementMetrics = {
  id: string;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  rectTop: number;
  rectBottom: number;
  rectHeight: number;
  overflowY: string;
  overflowX: string;
  height: string;
  minHeight: string;
  maxHeight: string;
  flex: string;
  position: string;
  touchAction: string;
  pointerEvents: string;
  overscrollBehaviorY: string;
};

type WorkerMetadata = {
  controllerPresent: boolean;
  controllerVersion: string | null;
  controllerCommit: string | null;
  controllerScript: string | null;
};

const MAX_REPORTS_PER_PAGE = DISCOVER_SCROLL_CHECKPOINTS.length;
const VERTICAL_SWIPE_THRESHOLD = 12;
const SCROLL_TOLERANCE_PX = 4;
let workerMetadataPromise: Promise<WorkerMetadata> | null = null;

function elementMetrics(element: Element | null, fallbackId: string): ElementMetrics | null {
  if (!(element instanceof HTMLElement)) return null;
  const style = window.getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  return {
    id: element.dataset.scrollOwner || element.dataset.discoverScrollRoot || fallbackId,
    scrollTop: Math.round(element.scrollTop),
    scrollHeight: Math.round(element.scrollHeight),
    clientHeight: Math.round(element.clientHeight),
    rectTop: Math.round(rect.top),
    rectBottom: Math.round(rect.bottom),
    rectHeight: Math.round(rect.height),
    overflowY: style.overflowY,
    overflowX: style.overflowX,
    height: style.height,
    minHeight: style.minHeight,
    maxHeight: style.maxHeight,
    flex: style.flex,
    position: style.position,
    touchAction: style.touchAction,
    pointerEvents: style.pointerEvents,
    overscrollBehaviorY: style.overscrollBehaviorY,
  };
}

function readSafeAreaInsets(): { top: number; right: number; bottom: number; left: number } {
  const probe = document.createElement("div");
  probe.style.cssText = [
    "position:fixed",
    "visibility:hidden",
    "pointer-events:none",
    "inset:0 auto auto 0",
    "padding-top:env(safe-area-inset-top, 0px)",
    "padding-right:env(safe-area-inset-right, 0px)",
    "padding-bottom:env(safe-area-inset-bottom, 0px)",
    "padding-left:env(safe-area-inset-left, 0px)",
  ].join(";");
  document.body.appendChild(probe);
  const style = window.getComputedStyle(probe);
  const insets = {
    top: Math.round(parseFloat(style.paddingTop) || 0),
    right: Math.round(parseFloat(style.paddingRight) || 0),
    bottom: Math.round(parseFloat(style.paddingBottom) || 0),
    left: Math.round(parseFloat(style.paddingLeft) || 0),
  };
  probe.remove();
  return insets;
}

function fullViewportPointerOverlayCount(): number {
  const minWidth = window.innerWidth * 0.9;
  const minHeight = window.innerHeight * 0.9;
  let count = 0;
  document.querySelectorAll<HTMLElement>(".fixed, .absolute, [role='dialog'], [data-radix-portal] > *")
    .forEach(element => {
      const style = window.getComputedStyle(element);
      if (
        (style.position === "fixed" || style.position === "absolute") &&
        style.pointerEvents !== "none" &&
        style.display !== "none" &&
        style.visibility !== "hidden"
      ) {
        const rect = element.getBoundingClientRect();
        if (rect.width >= minWidth && rect.height >= minHeight) count++;
      }
    });
  return count;
}

function getWorkerMetadata(): Promise<WorkerMetadata> {
  if (workerMetadataPromise) return workerMetadataPromise;
  if (!("serviceWorker" in navigator) || !navigator.serviceWorker.controller) {
    return Promise.resolve({
      controllerPresent: false,
      controllerVersion: null,
      controllerCommit: null,
      controllerScript: null,
    });
  }

  const controller = navigator.serviceWorker.controller;
  workerMetadataPromise = new Promise(resolve => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(() => {
      resolve({
        controllerPresent: true,
        controllerVersion: null,
        controllerCommit: null,
        controllerScript: controller.scriptURL || null,
      });
    }, 600);
    channel.port1.onmessage = event => {
      window.clearTimeout(timeout);
      resolve({
        controllerPresent: true,
        controllerVersion: typeof event.data?.version === "string" ? event.data.version : null,
        controllerCommit: typeof event.data?.commit === "string" ? event.data.commit : null,
        controllerScript: controller.scriptURL || null,
      });
    };
    try {
      controller.postMessage({ type: "GET_VERSION" }, [channel.port2]);
    } catch {
      window.clearTimeout(timeout);
      resolve({
        controllerPresent: true,
        controllerVersion: null,
        controllerCommit: null,
        controllerScript: controller.scriptURL || null,
      });
    }
  });
  return workerMetadataPromise;
}

function postDiagnostic(payload: Record<string, unknown>): void {
  void fetch(`${API_BASE}/api/diagnostics/discover-scroll`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify(payload),
    credentials: "omit",
    keepalive: true,
  }).catch(() => {
    // Diagnostics must never change a member-facing flow or add noisy PWA errors.
  });
}

export function useDiscoverScrollDiagnostics({
  rootRef,
  enabled,
  profileLoaded,
}: {
  rootRef: RefObject<HTMLDivElement>;
  enabled: boolean;
  profileLoaded: boolean;
}): void {
  const reported = useRef(new Set<DiscoverScrollCheckpoint>());
  const firstTouch = useRef<{ x: number; y: number; scrollTop: number } | null>(null);
  const firstVerticalMoveReported = useRef(false);
  const imageLoaded = useRef(false);
  const imageDecoded = useRef(false);

  const report = (checkpoint: DiscoverScrollCheckpoint, gesture?: { vertical: boolean; startScrollTop: number }) => {
    if (!enabled || reported.current.has(checkpoint) || reported.current.size >= MAX_REPORTS_PER_PAGE) return;
    const root = rootRef.current;
    const owner = root?.closest("main") as HTMLElement | null;
    if (!root || !owner) return;
    reported.current.add(checkpoint);

    const html = document.documentElement;
    const body = document.body;
    const appRoot = document.getElementById("root");
    const appLayout = owner.parentElement;
    const nav = document.querySelector<HTMLElement>("[data-bottom-navigation]");
    const viewport = window.visualViewport;
    const ownerMetrics = elementMetrics(owner, "app-layout-main");
    const rootMetrics = elementMetrics(root, "discover-root");
    const navMetrics = elementMetrics(nav, "bottom-navigation");

    void getWorkerMetadata().then(worker => {
      postDiagnostic({
        event: checkpoint,
        appBuild: {
          frontendCommit: __COMMIT_HASH__,
          frontendBuildTime: __BUILD_TIME__,
          expectedServiceWorkerVersion: __SW_VERSION__,
        },
        serviceWorker: worker,
        pwa: {
          displayModeStandalone: window.matchMedia?.("(display-mode: standalone)")?.matches === true,
          navigatorStandalone: (navigator as Navigator & { standalone?: boolean }).standalone === true,
          isIOS: /iPad|iPhone|iPod/.test(navigator.userAgent),
        },
        viewport: {
          innerHeight: window.innerHeight,
          innerWidth: window.innerWidth,
          visualViewportHeight: viewport ? Math.round(viewport.height) : null,
          visualViewportOffsetTop: viewport ? Math.round(viewport.offsetTop) : null,
          documentClientHeight: html.clientHeight,
          documentScrollHeight: html.scrollHeight,
          bodyClientHeight: body.clientHeight,
          bodyScrollHeight: body.scrollHeight,
          safeAreaInsets: readSafeAreaInsets(),
        },
        activeTab: "discover",
        profileLoaded,
        imageLoaded: imageLoaded.current,
        imageDecoded: imageDecoded.current,
        activeScrollOwner: ownerMetrics?.id ?? "unknown",
        scrollOwner: ownerMetrics,
        elements: {
          html: elementMetrics(html, "html"),
          body: elementMetrics(body, "body"),
          root: elementMetrics(appRoot, "root"),
          appLayout: elementMetrics(appLayout, "app-layout"),
          discoverRoot: rootMetrics,
          bottomNavigation: navMetrics,
        },
        locks: {
          htmlClassChatOpen: html.classList.contains("chat-open"),
          bodyClassChatOpen: body.classList.contains("chat-open"),
          htmlOverflowHidden: window.getComputedStyle(html).overflowY === "hidden",
          bodyOverflowHidden: window.getComputedStyle(body).overflowY === "hidden",
          rootOverflowHidden: appRoot ? window.getComputedStyle(appRoot).overflowY === "hidden" : false,
          fullViewportPointerOverlayCount: fullViewportPointerOverlayCount(),
        },
        gesture: gesture ?? null,
      });
    });
  };

  useEffect(() => {
    if (!enabled || !profileLoaded) return;
    const frame = window.requestAnimationFrame(() => {
      report("discover_mount");
      report("discover_profile_loaded");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [enabled, profileLoaded]);

  useEffect(() => {
    if (!enabled || !profileLoaded) return;
    const root = rootRef.current;
    if (!root) return;

    const scheduleImageCheckpoints = () => {
      if (imageLoaded.current) return;
      imageLoaded.current = true;
      const image = root.querySelector("img");
      void image?.decode?.().then(() => { imageDecoded.current = true; }).catch(() => {});
      window.setTimeout(() => report("image_loaded_plus_500ms"), 500);
      window.setTimeout(() => report("image_loaded_plus_1500ms"), 1500);
    };
    const onImageLoad = (event: Event) => {
      if (event.target instanceof HTMLImageElement) scheduleImageCheckpoints();
    };
    root.addEventListener("load", onImageLoad, true);
    if (root.querySelector<HTMLImageElement>("img")?.complete) scheduleImageCheckpoints();
    return () => root.removeEventListener("load", onImageLoad, true);
  }, [enabled, profileLoaded]);

  useEffect(() => {
    if (!enabled || !profileLoaded) return;
    const root = rootRef.current;
    const owner = root?.closest("main") as HTMLElement | null;
    if (!root || !owner) return;

    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touch || firstTouch.current) return;
      firstTouch.current = { x: touch.clientX, y: touch.clientY, scrollTop: owner.scrollTop };
      report("first_touch_start", { vertical: false, startScrollTop: owner.scrollTop });
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      const start = firstTouch.current;
      if (!touch || !start || firstVerticalMoveReported.current) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dy) < VERTICAL_SWIPE_THRESHOLD || Math.abs(dy) <= Math.abs(dx)) return;
      firstVerticalMoveReported.current = true;
      report("first_vertical_move", { vertical: true, startScrollTop: start.scrollTop });
    };
    const onTouchEnd = () => {
      const start = firstTouch.current;
      if (!start || !firstVerticalMoveReported.current) return;
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
        report("scroll_attempt", { vertical: true, startScrollTop: start.scrollTop });
        const rootRect = root.getBoundingClientRect();
        const ownerRect = owner.getBoundingClientRect();
        if (isDiscoverScrollStuck({
          verticalSwipe: true,
          startScrollTop: start.scrollTop,
          currentScrollTop: owner.scrollTop,
          scrollHeight: owner.scrollHeight,
          clientHeight: owner.clientHeight,
          contentBelowViewport: rootRect.bottom > ownerRect.bottom + SCROLL_TOLERANCE_PX,
        })) {
          report("scroll_stuck_detected", { vertical: true, startScrollTop: start.scrollTop });
        }
      }));
    };

    root.addEventListener("touchstart", onTouchStart, { passive: true });
    root.addEventListener("touchmove", onTouchMove, { passive: true });
    root.addEventListener("touchend", onTouchEnd, { passive: true });
    root.addEventListener("touchcancel", onTouchEnd, { passive: true });
    return () => {
      root.removeEventListener("touchstart", onTouchStart);
      root.removeEventListener("touchmove", onTouchMove);
      root.removeEventListener("touchend", onTouchEnd);
      root.removeEventListener("touchcancel", onTouchEnd);
    };
  }, [enabled, profileLoaded]);
}