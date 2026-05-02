/**
 * Dev-only performance instrumentation for Lulou.
 *
 * Every export is a no-op in production — import.meta.env.DEV is false-eliminated
 * by Vite's tree-shaker so there is literally zero runtime cost when deployed.
 *
 * ## Quick-reference
 *
 *   perfMark("DISCOVER/PAGE_MOUNT")
 *
 *   const end = perfStart("BATCH_PREFETCH")
 *   await doWork()
 *   end({ count: 5, payloadKb: 24 })
 *
 *   trackRequest("/api/discover")          // warns on duplicates within 2 s
 *
 *   logImageLoad(src, wasCached, startMs)  // decode time + format
 *   logImageError(src, startMs)
 *
 *   const { markDataReceived, markImageReady, markPageReady } = usePerfTrace("DISCOVER")
 */

import { useEffect, useRef, useCallback } from "react";

const isDev = import.meta.env.DEV;

// ── Mobile detection ─────────────────────────────────────────────────────────
/**
 * True when running on a mobile/touch device (iPhone, iPad, Android).
 * Detected once at module load — stable for the lifetime of the session.
 * Exported so other modules can use mobile-specific limits without a
 * separate utility import.
 */
export const isMobile: boolean =
  typeof navigator !== "undefined" &&
  /iPhone|iPad|iPod|Android|Mobile|webOS/i.test(navigator.userAgent);

/** True when running on iPhone/iPad specifically (excludes Android). */
export const isIOS: boolean =
  typeof navigator !== "undefined" &&
  /iPhone|iPad|iPod/.test(navigator.userAgent);

/**
 * Schedule a low-priority callback after the browser's first idle frame.
 *
 * Uses requestIdleCallback when available (Chrome, Safari 16.4+).
 * Falls back to setTimeout(100) on older browsers.
 *
 * Safe in production — no logging, just scheduling. Used to defer
 * non-critical work (avatar decoding, off-screen list expansion) until
 * after the critical first render completes.
 *
 * @param timeout  Max ms before the callback is forced regardless of
 *                 idle state. Default 1000 ms so work doesn't stall if
 *                 the user keeps scrolling.
 */
export function scheduleIdle(cb: () => void, timeout = 1000): void {
  if (typeof window === "undefined") { cb(); return; }
  if ("requestIdleCallback" in window) {
    (window as any).requestIdleCallback(cb, { timeout });
  } else {
    setTimeout(cb, 100);
  }
}

/**
 * Log mobile device info once per session — dev only.
 * Reports UA, viewport, DPR, CPU cores, memory, and network type so
 * you can distinguish iPhone 11 vs iPhone 15 performance profiles.
 */
let _deviceLogged = false;
export function logMobileDevice(): void {
  if (!isDev || !isMobile || _deviceLogged) return;
  _deviceLogged = true;
  const nav = navigator as any;
  console.log("[PERF] MOBILE_DEVICE", {
    t: rel(),
    ua: navigator.userAgent.slice(0, 100),
    screen: `${screen.width}×${screen.height}`,
    dpr: devicePixelRatio,
    vw: window.innerWidth,
    vh: window.innerHeight,
    cores: navigator.hardwareConcurrency ?? "?",
    memGb: nav.deviceMemory ?? "?",
    net: nav.connection?.effectiveType ?? "?",
  });
}

/**
 * Log total DOM node count — call after a page finishes rendering to catch
 * runaway node counts that degrade scroll performance on mobile.
 */
export function logDOMSize(label: string): void {
  if (!isDev) return;
  const count = document.querySelectorAll("*").length;
  console.log("[PERF] DOM_SIZE", { t: rel(), label, count });
}

/** Milliseconds since the JS bundle first executed (session-relative) */
const EPOCH = typeof performance !== "undefined" ? performance.now() : 0;
const rel = () => Math.round(performance.now() - EPOCH);

// ── Point-in-time mark ──────────────────────────────────────────────────────

export function perfMark(event: string, data?: Record<string, unknown>): void {
  if (!isDev) return;
  console.log(`[PERF] ${event}`, { t: rel(), ...data });
}

// ── Duration span ───────────────────────────────────────────────────────────

/**
 * Returns an end() function.  Call it when the operation finishes.
 * Logs nothing at start; only the DONE line (with ms elapsed) is emitted.
 */
export function perfStart(
  label: string,
  startData?: Record<string, unknown>,
): (endData?: Record<string, unknown>) => void {
  if (!isDev) return () => {};
  const t0 = performance.now();
  if (startData) console.log(`[PERF] ${label}/START`, { t: rel(), ...startData });
  return (endData?: Record<string, unknown>) => {
    const ms = Math.round(performance.now() - t0);
    console.log(`[PERF] ${label}/DONE`, { ms, t: rel(), ...endData });
  };
}

// ── Duplicate request detector ──────────────────────────────────────────────

/**
 * Call once per outgoing network request.
 * Warns if the same URL is hit more than once within a 2-second window.
 */
const _recentReqs = new Map<string, number[]>();

export function trackRequest(url: string): void {
  if (!isDev) return;
  const now = performance.now();
  const recent = (_recentReqs.get(url) ?? []).filter(t => now - t < 2000);
  if (recent.length >= 1) {
    console.warn(
      `[PERF] DUPLICATE_REQUEST — "${url}" fired ${recent.length + 1}× within 2 s`,
    );
  }
  recent.push(now);
  _recentReqs.set(url, recent);
}

// ── Image timing ─────────────────────────────────────────────────────────────

/**
 * Log image decode completion — call inside preloadPhoto's onload.
 * Reports: decode duration, image type (base64 vs storage-url), size, cache status.
 */
export function logImageLoad(
  src: string,
  wasCached: boolean,
  startMs: number,
): void {
  if (!isDev) return;
  const decodeMs = Math.round(performance.now() - startMs);
  const type = src.startsWith("data:") ? "base64" : "storage-url";
  const sizeKb = Math.round(src.length / 1024);
  const preview = src.length > 80 ? src.slice(0, 70) + "…" : src;
  console.log(`[PERF] IMAGE_DECODED`, {
    t: rel(),
    decodeMs,
    type,
    wasCached,
    sizeKb,
    preview,
  });
}

/** Log image fetch/decode failure */
export function logImageError(src: string, startMs: number): void {
  if (!isDev) return;
  const ms = Math.round(performance.now() - startMs);
  const type = src.startsWith("data:") ? "base64" : "storage-url";
  console.warn(`[PERF] IMAGE_ERROR`, { t: rel(), ms, type });
}

// ── Page lifecycle hook ───────────────────────────────────────────────────────

/**
 * usePerfTrace — tracks the four lifecycle milestones for a page.
 *
 *   PAGE_MOUNT        → component first renders
 *   DATA_RECEIVED     → first meaningful list data arrives from the server
 *   FIRST_IMAGE_READY → first above-the-fold photo bitmap decoded
 *   PAGE_READY        → skeleton removed, full content visible
 *
 * All timings are in ms relative to PAGE_MOUNT so they show exactly how long
 * each step took from the user's perspective.
 *
 * Each marker fires at most once per mount (duplicate calls are ignored) so
 * it is safe to call them inside render-phase callbacks.
 *
 * @example
 *   const { markDataReceived, markImageReady, markPageReady } = usePerfTrace("DISCOVER");
 *
 *   useEffect(() => { if (profiles?.length) markDataReceived({ count: profiles.length }); }, [profiles]);
 *   // in JSX:  <img onLoad={markImageReady} ... />
 *   // once skeleton unmounts:  markPageReady()
 */
export function usePerfTrace(page: string) {
  const mountedAt = useRef(0);
  const dataFired  = useRef(false);
  const imageFired = useRef(false);
  const readyFired = useRef(false);

  useEffect(() => {
    mountedAt.current = performance.now();
    logMobileDevice(); // no-op in production and on desktop
    perfMark(`${page}/PAGE_MOUNT`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markDataReceived = useCallback((data?: Record<string, unknown>) => {
    if (!isDev || dataFired.current) return;
    dataFired.current = true;
    perfMark(`${page}/DATA_RECEIVED`, {
      sinceMount: Math.round(performance.now() - mountedAt.current),
      ...data,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markImageReady = useCallback(() => {
    if (!isDev || imageFired.current) return;
    imageFired.current = true;
    perfMark(`${page}/FIRST_IMAGE_READY`, {
      sinceMount: Math.round(performance.now() - mountedAt.current),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const markPageReady = useCallback((data?: Record<string, unknown>) => {
    if (!isDev || readyFired.current) return;
    readyFired.current = true;
    const sinceMount = Math.round(performance.now() - mountedAt.current);
    perfMark(`${page}/PAGE_READY`, { sinceMount, ...data });
    // Fire a full snapshot alongside every PAGE_READY mark so we get DOM count,
    // memory, and network info at the exact moment each page becomes interactive.
    reportMobileSnapshot(page, { sinceMount, ...data });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { markDataReceived, markImageReady, markPageReady };
}

// ── Render counter ────────────────────────────────────────────────────────────
/**
 * Log how many times a component has rendered since it mounted — dev only.
 * Emits a warning at 6 and 10 renders (suggests a dependency loop).
 * Always calls hooks so React's rules-of-hooks are satisfied; the `isDev`
 * guard makes the logging dead-code-eliminated in production by Vite.
 *
 * @example  useRenderCount("MatchCard")
 */
export function useRenderCount(name: string): void {
  const count = useRef(0);
  count.current += 1;
  const c = count.current;
  useEffect(() => {
    if (!isDev) return;
    if (c === 1) return; // first render is expected
    console.log(`[PERF] RENDER — ${name} #${c}`, { t: rel() });
    if (c === 6)  console.warn(`[PERF] RENDER_6x  — ${name} — check useEffect/useMemo deps`, { t: rel() });
    if (c === 10) console.warn(`[PERF] RENDER_10x — ${name} — likely dependency loop`, { t: rel() });
  });
}

// ── Mobile snapshot ───────────────────────────────────────────────────────────
/**
 * Log a comprehensive point-in-time health snapshot.
 * Captures DOM node count, JS heap size (Chrome/Android only), network RTT.
 * Call on PAGE_READY to establish a baseline for each page.
 * Emits a DOM node warning when count > 1500 (scroll jank threshold on iPhone).
 */
export function reportMobileSnapshot(
  page: string,
  extra?: Record<string, unknown>,
): void {
  if (!isDev) return;
  const dom = document.querySelectorAll("*").length;
  const mem = (performance as any).memory;
  const nav = navigator as any;
  console.log(`[PERF] SNAPSHOT/${page}`, {
    t: rel(),
    domNodes: dom,
    memUsedMb: mem ? Math.round(mem.usedJSHeapSize / 1_048_576) : "n/a",
    memLimitMb: mem ? Math.round(mem.jsHeapSizeLimit / 1_048_576) : "n/a",
    net: nav.connection?.effectiveType ?? "?",
    rtt: nav.connection?.rtt ?? "?",
    ...extra,
  });
  if (dom > 1500) {
    console.warn(`[PERF] DOM_NODE_WARNING — ${dom} nodes on ${page} (threshold: 1500)`);
  }
}
