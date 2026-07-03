/**
 * mic-permission.ts — Shared microphone permission + stream manager.
 *
 * WHY THIS EXISTS
 * ───────────────
 * In matches.tsx the chatroom component mounts/unmounts every time the user
 * switches between conversations. The previous per-component micStreamRef was
 * destroyed on every unmount (cleanup effect stopped the tracks), forcing a
 * fresh getUserMedia() call on the next recording press. Even though iOS Safari
 * does not show the permission dialog again after the first grant, every fresh
 * getUserMedia() call:
 *   1. Shows the orange mic indicator dot in the iOS status bar again.
 *   2. Takes 50-200 ms to resolve asynchronously — recording cannot start
 *      until the promise settles, so there's a perceivable lag.
 *
 * SOLUTION
 * ────────
 * A single MediaStream is kept alive at module scope for the entire browser
 * session. Components borrow it — they DO NOT stop its tracks on unmount.
 * The stream is released only on explicit logout or when iOS marks it inactive.
 *
 * PRE-WARM
 * ────────
 * When a chat view mounts and we already know mic permission was granted
 * (localStorage flag), we call getUserMedia() in the background immediately
 * (not on button press). This way the stream is hot before the user's first
 * hold — recording starts with zero async delay.
 *
 * localStorage key: "lulou_mic_granted" = "1"
 *   Set after the first successful getUserMedia().
 *   Cleared only if the user explicitly blocks mic in iOS Settings.
 *
 * Does NOT share state with WebRTC call audio.
 * Call audio uses its own separate stream inside use-webrtc.ts.
 */

const STORAGE_KEY = "lulou_mic_granted";

export type MicPermState = "unknown" | "granted" | "denied" | "unavailable";

// ── Module-level state ──────────────────────────────────────────────────────
let _stream: MediaStream | null = null;
let _permState: MicPermState = "unknown";
let _pendingPromise: Promise<MediaStream> | null = null;

// Initialise from localStorage so pre-warm decisions work immediately.
if (typeof window !== "undefined") {
  try {
    if (localStorage.getItem(STORAGE_KEY) === "1") _permState = "granted";
  } catch { /* ignore */ }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function _isLive(s: MediaStream | null): boolean {
  return !!(s && s.active && s.getTracks().some(t => t.readyState === "live"));
}

function _persist(granted: boolean) {
  try {
    if (granted) localStorage.setItem(STORAGE_KEY, "1");
    else localStorage.removeItem(STORAGE_KEY);
  } catch { /* ignore */ }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** True if a previous session granted mic permission (localStorage). */
export function wasMicGrantedBefore(): boolean {
  return _permState === "granted";
}

/** Current in-memory permission state. */
export function getMicPermState(): MicPermState {
  return _permState;
}

/**
 * Get the shared live stream, or null if not yet acquired / iOS killed it.
 * Components can call this to check before requesting.
 */
export function getSharedMicStream(): MediaStream | null {
  return _isLive(_stream) ? _stream : null;
}

/**
 * Request mic access and return the shared stream.
 *
 * - If a live stream already exists, returns it immediately (no getUserMedia).
 * - If a request is already in flight, waits for it (no duplicate getUserMedia).
 * - On first call (or after iOS killed the stream): calls getUserMedia once.
 *
 * Throws on NotAllowedError (permission denied) or NotFoundError (no mic).
 */
export async function requestMicStream(): Promise<MediaStream> {
  // Fast path — stream is already live.
  if (_isLive(_stream)) {
    console.log("[VOICE_NOTE_MIC] permission already granted — reusing live stream");
    return _stream!;
  }

  // Deduplicate concurrent calls.
  if (_pendingPromise) {
    console.log("[VOICE_NOTE_MIC] getUserMedia already in flight — waiting");
    return _pendingPromise;
  }

  const isFirstRequest = _permState !== "granted";
  if (isFirstRequest) {
    console.log("[VOICE_NOTE_MIC] first permission request");
  } else {
    console.log("[VOICE_NOTE_MIC] stream was released (iOS sleep?) — re-acquiring");
  }

  _pendingPromise = navigator.mediaDevices
    .getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true,
        sampleRate: 48000,
      },
    })
    .then(stream => {
      _stream = stream;
      _permState = "granted";
      _pendingPromise = null;
      _persist(true);
      console.log("[VOICE_NOTE_MIC] permission granted — stream live");
      return stream;
    })
    .catch(err => {
      _pendingPromise = null;
      const isDenied = err?.name === "NotAllowedError" || err?.name === "PermissionDeniedError";
      if (isDenied) {
        _permState = "denied";
        _persist(false);
        console.log("[VOICE_NOTE_MIC] permission denied");
      } else if (err?.name === "NotFoundError" || err?.name === "DevicesNotFoundError") {
        _permState = "unavailable";
        console.log("[VOICE_NOTE_MIC] no microphone found");
      } else {
        console.warn("[VOICE_NOTE_MIC] getUserMedia error", err?.name, err?.message);
      }
      throw err;
    });

  return _pendingPromise;
}

/**
 * Pre-warm the mic stream silently in the background.
 * Call this on component mount when voiceNotesUnlocked is true and
 * wasMicGrantedBefore() is true. Swallows all errors — non-critical.
 */
export async function prewarmMicStream(): Promise<void> {
  if (_isLive(_stream)) return; // already live
  if (_permState === "denied" || _permState === "unavailable") return;
  if (_pendingPromise) return; // already warming
  try {
    await requestMicStream();
    console.log("[VOICE_NOTE_MIC] pre-warm complete — stream ready before first press");
  } catch {
    // Silently swallow — denied/no-mic is handled at record time.
  }
}

/**
 * Release the shared stream.
 * Call only on user logout or explicit permission revocation.
 * Do NOT call on component unmount — the stream should outlive individual renders.
 */
export function releaseMicStream(reason: string): void {
  if (_stream) {
    _stream.getTracks().forEach(t => t.stop());
    _stream = null;
    console.log("[VOICE_NOTE_MIC] stream released:", reason);
  }
}
