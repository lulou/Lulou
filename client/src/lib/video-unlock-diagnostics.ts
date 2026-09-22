import { API_BASE } from "@/lib/queryClient";

export type VideoUnlockSource =
  | "matches_tray"
  | "matches_composer"
  | "messaging_tray"
  | "messaging_composer";

type VideoUnlockEvent =
  | "video_unlock_pointerdown"
  | "video_unlock_click"
  | "video_unlock_handler_entered"
  | "video_unlock_state"
  | "video_unlock_prompt_requested"
  | "video_unlock_prompt_state_changed"
  | "video_unlock_prompt_rendered";

type VideoUnlockDiagnostic = {
  event: VideoUnlockEvent;
  diagId: string;
  source: VideoUnlockSource;
  route: string;
  clientAt: number;
  videoState?: "locked" | "available" | "used_paid" | "recording";
  purchaseRequired?: boolean;
  promptOpen?: boolean;
  targetTestId?: string | null;
  hitTestId?: string | null;
  controlRect?: { top: number; left: number; width: number; height: number };
  controlStyle?: {
    zIndex: string;
    pointerEvents: string;
    touchAction: string;
    position: string;
    display: string;
    visibility: string;
    opacity: string;
  };
  sheet?: {
    mounted: boolean;
    visible: boolean;
    zIndex: string | null;
    pointerEvents: string | null;
    top: number | null;
    height: number | null;
  };
  standalone?: boolean;
  isIOS?: boolean;
};

const activeDiagnostics = new Map<VideoUnlockSource, string>();

function createDiagnosticId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function report(payload: VideoUnlockDiagnostic): void {
  console.info(`[VIDEO_UNLOCK_DIAG] ${payload.event}`, payload);
  try {
    void fetch(`${API_BASE}/api/diagnostics/video-unlock`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => undefined);
  } catch {
    // Diagnostics must never affect the Video Unlock interaction.
  }
}

function platformFacts() {
  const standaloneMedia = typeof window !== "undefined"
    && window.matchMedia?.("(display-mode: standalone)").matches;
  const navigatorStandalone = typeof navigator !== "undefined"
    && (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return {
    route: typeof window !== "undefined" ? window.location.pathname : "unknown",
    standalone: Boolean(standaloneMedia || navigatorStandalone),
    isIOS: typeof navigator !== "undefined" && /iPad|iPhone|iPod/.test(navigator.userAgent),
  };
}

function currentId(source: VideoUnlockSource): string {
  const existing = activeDiagnostics.get(source);
  if (existing) return existing;
  const created = createDiagnosticId();
  activeDiagnostics.set(source, created);
  return created;
}

export function reportVideoUnlockPointerDown(
  source: VideoUnlockSource,
  event: React.PointerEvent<HTMLButtonElement>,
): void {
  const diagId = createDiagnosticId();
  activeDiagnostics.set(source, diagId);
  const control = event.currentTarget;
  const rect = control.getBoundingClientRect();
  const style = window.getComputedStyle(control);
  const hit = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null;
  report({
    event: "video_unlock_pointerdown",
    diagId,
    source,
    clientAt: Date.now(),
    ...platformFacts(),
    targetTestId: control.dataset.testid ?? null,
    hitTestId: hit?.closest<HTMLElement>("[data-testid]")?.dataset.testid ?? null,
    controlRect: {
      top: Math.round(rect.top),
      left: Math.round(rect.left),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
    controlStyle: {
      zIndex: style.zIndex,
      pointerEvents: style.pointerEvents,
      touchAction: style.touchAction,
      position: style.position,
      display: style.display,
      visibility: style.visibility,
      opacity: style.opacity,
    },
  });
}

export function reportVideoUnlockClick(source: VideoUnlockSource): void {
  report({
    event: "video_unlock_click",
    diagId: currentId(source),
    source,
    clientAt: Date.now(),
    ...platformFacts(),
  });
}

export function reportVideoUnlockHandler(
  source: VideoUnlockSource,
  videoState: "locked" | "available" | "used_paid" | "recording",
  purchaseRequired: boolean,
): void {
  const shared = {
    diagId: currentId(source),
    source,
    clientAt: Date.now(),
    ...platformFacts(),
    videoState,
    purchaseRequired,
  };
  report({ event: "video_unlock_handler_entered", ...shared });
  report({ event: "video_unlock_state", ...shared });
}

export function reportVideoUnlockPromptRequested(
  source: VideoUnlockSource,
  videoState: "locked" | "available" | "used_paid" | "recording",
  purchaseRequired: boolean,
): void {
  report({
    event: "video_unlock_prompt_requested",
    diagId: currentId(source),
    source,
    clientAt: Date.now(),
    ...platformFacts(),
    videoState,
    purchaseRequired,
  });
}

export function reportVideoUnlockPromptStateChanged(
  source: VideoUnlockSource,
  promptOpen: boolean,
): void {
  report({
    event: "video_unlock_prompt_state_changed",
    diagId: currentId(source),
    source,
    clientAt: Date.now(),
    ...platformFacts(),
    promptOpen,
  });
}

export function reportVideoUnlockPromptRendered(source: VideoUnlockSource): void {
  window.requestAnimationFrame(() => {
    const sheet = document.querySelector<HTMLElement>('[data-testid="purchase-prompt-sheet"]');
    const rect = sheet?.getBoundingClientRect();
    const style = sheet ? window.getComputedStyle(sheet) : null;
    report({
      event: "video_unlock_prompt_rendered",
      diagId: currentId(source),
      source,
      clientAt: Date.now(),
      ...platformFacts(),
      promptOpen: true,
      sheet: {
        mounted: Boolean(sheet),
        visible: Boolean(
          sheet
          && rect
          && rect.width > 0
          && rect.height > 0
          && style?.display !== "none"
          && style?.visibility !== "hidden"
          && Number(style?.opacity ?? "1") > 0
        ),
        zIndex: style?.zIndex ?? null,
        pointerEvents: style?.pointerEvents ?? null,
        top: rect ? Math.round(rect.top) : null,
        height: rect ? Math.round(rect.height) : null,
      },
    });
  });
}