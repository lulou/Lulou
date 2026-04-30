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
    perfMark(`${page}/PAGE_READY`, {
      sinceMount: Math.round(performance.now() - mountedAt.current),
      ...data,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { markDataReceived, markImageReady, markPageReady };
}
