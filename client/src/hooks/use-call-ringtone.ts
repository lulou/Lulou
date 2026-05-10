/**
 * use-call-ringtone — EMERGENCY SILENT MODE
 *
 * All ringtone/ringback sounds are disabled. This hook is now a complete no-op.
 * The underlying call-audio.ts startIncomingRingtone / startOutgoingRingback
 * functions are also stubs that do nothing.
 *
 * [CALL_AUDIO_EMERGENCY] all custom call sounds disabled
 */
export type RingtoneType = "incoming" | "outgoing";

export function useCallRingtone(_type: RingtoneType, _enabled: boolean) {
  // No-op — all ringtone/ringback sounds removed in emergency silent mode.
}
