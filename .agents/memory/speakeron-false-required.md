---
name: speakerOn default must be false
description: Why speakerOn must always initialise to false — setting it to isVideo causes acoustic feedback screeching on iPhone Safari.
---

## Rule
`const [speakerOn, setSpeakerOn] = useState(false)` — always false for ALL call types (audio and video).

**Why:**
On iPhone Safari (plain web, no Capacitor wrapper), `configureVoiceChat()` and `setSpeaker()` in `audio-session.ts` are **complete no-ops**. The ONLY audio routing control the browser exposes is `el.volume`. The iPhone speaker is physically millimetres from the open microphone. At `el.volume = 1.0` (what `speakerOn=true` sets), the mic picks up the speaker output. Without native hardware AEC (which requires `AVAudioSession` voiceChat mode, only available via Capacitor), Safari's software AEC cannot suppress the loop. Result: acoustic feedback escalates into screeching and then ringing tones (beeping at ~440/480 Hz resonance).

At `el.volume = 0.25` (what `speakerOn=false` sets) the signal is weak enough for the software AEC to handle.

**How to apply:**
- Never set `useState(isVideo)` or any non-false default for `speakerOn`.
- Users can still tap the speaker button during an audio call to toggle volume up to 1.0 (their choice, their risk with the mic open).
- Video calls on iPhone stay at 0.25 — they're inherently safer because users tend to hold the phone away from their face, but the default must still be safe.
- On desktop Chrome/Android, the `setSinkId("default")` path always uses `volume=1.0` regardless of `speakerOn`; hardware AEC handles the echo correctly there.
