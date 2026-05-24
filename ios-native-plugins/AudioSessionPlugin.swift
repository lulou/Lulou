import Capacitor
import AVFoundation

/**
 * AudioSessionPlugin
 *
 * Capacitor plugin that gives the JS layer direct control over iOS AVAudioSession.
 *
 * Installation (after `npx cap add ios` on Mac):
 *   1. Copy AudioSessionPlugin.swift + AudioSessionPlugin.m into
 *      ios/App/App/Plugins/
 *   2. Run `npx cap sync` to re-bundle the web assets.
 *   3. Build and run in Xcode on a real iPhone.
 *
 * Why .voiceChat mode?
 *   - Routes audio to the earpiece by default (not loudspeaker).
 *   - Activates the hardware acoustic echo canceller (AEC) — far superior to
 *     any software approach and eliminates loudspeaker-to-mic feedback.
 *   - Enables Bluetooth (AirPods, etc.) automatically.
 *   - overrideOutputAudioPort(.speaker) switches to loudspeaker when the user
 *     taps the Speaker button; .none returns to earpiece.
 */
@objc(AudioSessionPlugin)
public class AudioSessionPlugin: CAPPlugin {

  /// Configure AVAudioSession for a voice call.
  /// Sets category .playAndRecord + mode .voiceChat.
  /// Call once when WebRTC transitions to "connected".
  @objc func configure(_ call: CAPPluginCall) {
    do {
      let session = AVAudioSession.sharedInstance()
      try session.setCategory(
        .playAndRecord,
        mode: .voiceChat,
        options: [
          .allowBluetooth,
          .allowBluetoothA2DP,
          .allowAirPlay,
        ]
      )
      try session.setActive(true)
      call.resolve([
        "route": currentRouteDescription(session),
      ])
    } catch {
      call.reject("AVAudioSession configure failed: \(error.localizedDescription)", nil, error)
    }
  }

  /// Route audio to loudspeaker (enabled=true) or earpiece (enabled=false).
  /// Wraps overrideOutputAudioPort(.speaker / .none).
  @objc func setSpeaker(_ call: CAPPluginCall) {
    let enabled = call.getBool("enabled") ?? false
    do {
      let session = AVAudioSession.sharedInstance()
      try session.overrideOutputAudioPort(enabled ? .speaker : .none)
      call.resolve([
        "enabled": enabled,
        "route": currentRouteDescription(session),
      ])
    } catch {
      call.reject("setSpeaker failed: \(error.localizedDescription)", nil, error)
    }
  }

  /// Deactivate the audio session when the call ends.
  /// Restores the system default audio session for other apps.
  @objc func deactivate(_ call: CAPPluginCall) {
    do {
      try AVAudioSession.sharedInstance().setActive(
        false,
        options: .notifyOthersOnDeactivation
      )
      call.resolve()
    } catch {
      call.reject("deactivate failed: \(error.localizedDescription)", nil, error)
    }
  }

  // MARK: - Helpers

  private func currentRouteDescription(_ session: AVAudioSession) -> String {
    let outputs = session.currentRoute.outputs.map { $0.portType.rawValue }.joined(separator: ", ")
    return outputs.isEmpty ? "none" : outputs
  }
}
