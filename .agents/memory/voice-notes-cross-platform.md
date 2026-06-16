---
name: Voice notes cross-platform
description: Safari/iOS cannot record or play WebM; FFmpeg transcoding pipeline converts all uploads to AAC/M4A before Supabase Storage.
---

## Rule
All voice note uploads are transcoded to AAC/M4A on the server before being stored in Supabase. The client records in its native format (WebM for Chrome/Android, MP4 for Safari/iOS) — the server normalises everything.

**Why:** WebM/Opus is not supported on any version of Safari or iOS. Storing the raw recording format means Chrome → iPhone playback always fails. AAC inside an MP4 container is the only format universally supported by Chrome, Firefox, Safari (desktop + iOS), and Edge.

**How to apply:**
- `server/transcoder.ts` — standalone FFmpeg wrapper, no npm deps needed. Writes to `os.tmpdir()`, always cleans up temp files.
- `server/routes.ts` — `transcodeToM4a(audioBuffer, safeMime)` is called after base64 decode and size check. Output always uploaded as `audio/mp4` with `.m4a` extension.
- FFmpeg 6.1.2 is available in the Replit Nix environment at `ffmpeg` on PATH. Confirmed working via `spawn("ffmpeg", ...)`.
- Settings: `-c:a aac -b:a 64k -ac 1 -ar 44100 -movflags +faststart`. Mono 64kbps AAC with faststart for streaming.
- Transcode speed: ~15x realtime (60-second recording transcodes in ~4 seconds).
- Output sizes: 3s ≈ 25KB, 30s ≈ 240KB, 60s ≈ 480KB.

## Client-side MIME chain
Both `messaging.tsx` and `matches.tsx` probe in this order: `audio/webm;codecs=opus` → `audio/ogg;codecs=opus` → `audio/webm` → `audio/mp4`. Falls back to `new MediaRecorder(stream)` with no mimeType if none matches.

## Playback error state
Both `VoiceNotePlayer` and `VoiceNoteBubble` have `audioError` state + `onError` handler. This is a safety net for old pre-transcoding voice notes (WebM files stored before this fix) and network errors.
