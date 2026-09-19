/**
 * audio-session.ts
 *
 * JS bridge to the native iOS AVAudioSession Capacitor plugin.
 *
 * When running inside the Capacitor iOS wrapper the plugin is available and
 * every call routes to Swift, which configures AVAudioSession with:
 *   - category: .playAndRecord
 *   - mode:     .voiceChat   ← earpiece default + hardware AEC
 *   - options:  allowBluetooth, allowBluetoothA2DP, allowAirPlay
 *
 * When running in a plain web browser (Safari, Chrome, desktop) all calls
 * are no-ops so the existing web fallbacks (volume control, setSinkId) remain
 * in effect and nothing breaks.
 *
 * Swift plugin source: ios-native-plugins/AudioSessionPlugin.swift
 * Must be copied into ios/App/App/Plugins/ after `npx cap add ios` on Mac.
 */

function getPlugin(): any | null {
  try {
    const cap = (window as any).Capacitor;
    if (!cap) return null;
    return cap.Plugins?.AudioSession ?? null;
  } catch {
    return null;
  }
}

function getWebAudioSession(): { type: string } | null {
  try {
    return (navigator as Navigator & { audioSession?: { type: string } }).audioSession ?? null;
  } catch {
    return null;
  }
}

function isIOSWeb(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/**
 * Configure AVAudioSession for a voice call.
 * Sets .playAndRecord + .voiceChat — routes audio to earpiece by default
 * and activates hardware AEC. Call this once when WebRTC connects.
 */
export async function configureVoiceChat(): Promise<void> {
  const webSession = getWebAudioSession();
  if (webSession) {
    webSession.type = "play-and-record";
    console.log("[WEB_AUDIO_SESSION] configured play-and-record");
  }

  const p = getPlugin();
  if (!p) return;
  try {
    await p.configure();
    console.log("[NATIVE_AUDIO] AVAudioSession configured: voiceChat mode, earpiece default");
  } catch (err) {
    console.warn("[NATIVE_AUDIO] configure failed", err);
  }
}

/**
 * Route audio to loudspeaker (enabled=true) or back to earpiece (enabled=false).
 * Wraps AVAudioSession.overrideOutputAudioPort(.speaker / .none).
 * Call this whenever the speaker button is toggled.
 */
export async function setSpeaker(enabled: boolean): Promise<void> {
  const p = getPlugin();
  if (!p) return;
  try {
    await p.setSpeaker({ enabled });
    console.log("[NATIVE_AUDIO] setSpeaker", { enabled });
  } catch (err) {
    console.warn("[NATIVE_AUDIO] setSpeaker failed", err);
  }
}

/**
 * Use Safari's real output-device routing when iOS exposes receiver and speaker
 * sinks. Returns false when routing is unavailable or the desired route cannot
 * be identified, allowing callers to use the conservative volume fallback.
 */
export async function setWebSpeakerRoute(
  element: HTMLMediaElement,
  enabled: boolean,
): Promise<boolean> {
  if (!isIOSWeb()) return false;
  const setSinkId = (element as HTMLMediaElement & {
    setSinkId?: (sinkId: string) => Promise<void>;
  }).setSinkId;
  if (typeof setSinkId !== "function" || !navigator.mediaDevices?.enumerateDevices) {
    return false;
  }

  try {
    const outputs = (await navigator.mediaDevices.enumerateDevices())
      .filter(device => device.kind === "audiooutput");
    const speakerPattern = /speaker|loudspeaker|haut-parleur|altavoz|lautsprecher|altoparlante|扬声器|揚聲器|スピーカー|스피커|مكبر/i;
    const receiverPattern = /receiver|earpiece|combiné|auricular|hörmuschel|ricevitore|听筒|聽筒|レシーバー|수화기|سماعة الأذن/i;
    const desired = enabled
      ? outputs.find(device => speakerPattern.test(device.label))
      : outputs.find(device => receiverPattern.test(device.label));
    if (!desired) {
      console.warn("[WEB_AUDIO_ROUTE] desired iPhone output not identified", {
        enabled,
        outputCount: outputs.length,
        labelsPresent: outputs.map(device => Boolean(device.label)),
      });
      return false;
    }

    await setSinkId.call(element, desired.deviceId);
    console.log("[WEB_AUDIO_ROUTE] iPhone output switched", {
      route: enabled ? "speaker" : "receiver",
    });
    return true;
  } catch (error) {
    console.warn("[WEB_AUDIO_ROUTE] iPhone output switch failed", {
      enabled,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * Deactivate the AVAudioSession when the call ends.
 * This restores the system's default audio session for other apps.
 * Call this on component unmount / call ended.
 */
export async function deactivateAudioSession(): Promise<void> {
  const webSession = getWebAudioSession();
  if (webSession) {
    webSession.type = "auto";
    console.log("[WEB_AUDIO_SESSION] restored auto");
  }

  const p = getPlugin();
  if (!p) return;
  try {
    await p.deactivate();
    console.log("[NATIVE_AUDIO] AVAudioSession deactivated");
  } catch (err) {
    console.warn("[NATIVE_AUDIO] deactivate failed", err);
  }
}
