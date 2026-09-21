---
name: Voice notes cross-platform
description: Cross-platform voice uploads require complete browser containers and verified server-side FFmpeg normalization.
---

All accepted voice-note uploads must be decoded and normalized to AAC/M4A before storage. iOS recording must use one stop-time blob rather than timesliced fragments; a `moof`-only MP4 has no initialization segment and must be rejected, not repaired or published.

**Why:** Production produced an HTTP-200 `audio/mp4` object that started with `moof` and lacked `ftyp`; FFmpeg and recipient browsers correctly rejected it. Normalizing complete MP4/WebM/Ogg inputs produces one broadly playable format.

**How to apply:** Accept only containers validated by magic bytes, use the packaged static FFmpeg binary in production, and test with a real iPhone sample. A package can resolve while its downloaded binary is absent when lifecycle scripts were skipped; verify the binary exists before trusting a transcode test, while retaining system `ffmpeg` only as a development fallback.
