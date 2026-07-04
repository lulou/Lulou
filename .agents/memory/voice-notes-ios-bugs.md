---
name: iOS voice notes root causes
description: Five root causes of composer shift and send failures in the voice note feature on iPhone, and the fixes applied.
---

## Rule: iOS MIME type must be resolved before upload

iOS Safari's `MediaRecorder.isTypeSupported("audio/mp4")` can return `false` on iOS <16, leading to the fallback `new MediaRecorder(stream)` with no explicit mimeType. In that case `recorder.mimeType` may be an empty string. If `actualMimeType` is empty, the upload header `Content-Type` defaults to `audio/webm` — but the actual bytes are iOS MP4 fragmented audio. FFmpeg receives a `.webm` extension file with MP4 content → transcode fails → 500.

**Fix:** Put `audio/mp4` first in preferred types for iOS (UA detection). Three-layer MIME resolution: `recorder.mimeType || mimeType || (isIOS ? "audio/mp4" : "audio/webm")`.

**Why:** iOS records only MP4/AAC regardless of what you request. Always resolve the actual type from the recorder, not the requested one.

## Rule: visualViewport keyboard-close must be suppressed during recording

The visualViewport resize handler fires when the iOS keyboard closes. Even with `!keyboardOpen` gating the AI/phone flex buttons, if `keyboardOpen` changes to `false` mid-recording, those buttons re-insert → flex shift. The shift happens even when the keyboard didn't actually close (false alarm from iOS blur events).

**Fix:** In the visualViewport handler, add `if (isRecordingRef.current && !kbVisible) return;`. After `stopRecording()`, call a one-time viewport re-sync: read `visualViewport.height`, compute actual keyboard state, call `setKeyboardOpen(...)`.

**Why:** Recording must be a "frozen" period for keyboard state so DOM structure stays identical throughout.

## Rule: blob.size === 0 in onstop must never be silent

iOS Safari has a timing bug where `onstop` fires before the final `ondataavailable` chunk. When this happens `audioChunksRef.current` is empty → `blob.size = 0` → the `if (blob.size > 0)` guard exits silently. User sees the mic button go back to idle with no bubble, no toast, no error.

**Fix:** Explicitly check `blob.size === 0` before the `> 0` guard and show a toast: "Recording failed — please try again".

## Rule: Supabase CDN propagation takes up to 10 seconds

After `storage.upload()` completes, CDN edge nodes may not serve the file for 3-8+ seconds. The old retry strategy (3 retries × 1.5s = 4.5s) times out too quickly in some regions. Increase to 5 retries × 2s = 10 seconds total coverage.

## Rule: ios audio/mp4 fast path in FFmpeg is correct

Server transcoder already handles iOS fMP4 correctly: `-fflags +genpts+igndts -i input.mp4 -c:a copy -movflags +faststart`. No re-encoding needed. The key is that the client sends the correct MIME type so the server knows to use this fast path.
