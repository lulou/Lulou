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

/**
 * Configure AVAudioSession for a voice call.
 * Sets .playAndRecord + .voiceChat — routes audio to earpiece by default
 * and activates hardware AEC. Call this once when WebRTC connects.
 */
export async function configureVoiceChat(): Promise<void> {
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
 * Deactivate the AVAudioSession when the call ends.
 * This restores the system's default audio session for other apps.
 * Call this on component unmount / call ended.
 */
export async function deactivateAudioSession(): Promise<void> {
  const p = getPlugin();
  if (!p) return;
  try {
    await p.deactivate();
    console.log("[NATIVE_AUDIO] AVAudioSession deactivated");
  } catch (err) {
    console.warn("[NATIVE_AUDIO] deactivate failed", err);
  }
}
