---
name: Camera stream timing fix
description: Pattern to attach getUserMedia stream to a video element that is conditionally rendered in React
---

## Rule

Never call `videoRef.current.srcObject = stream` in the same function that changes the state which renders the `<video>` element. The video element does not exist in the DOM yet when that line runs, so `videoRef.current` is null and the camera shows a black screen.

**Correct pattern:**
1. Get the stream via `getUserMedia`.
2. Store it in a ref: `streamRef.current = stream`.
3. Call `setSelfieStep("camera")` — this triggers a re-render that mounts the `<video>` element.
4. In a `useEffect([selfieStep])`, attach and play:
   ```ts
   useEffect(() => {
     if (selfieStep !== "camera") return;
     const video = videoRef.current;
     const stream = streamRef.current;
     if (!video || !stream) return;
     video.srcObject = stream;
     video.play().catch(() => {});
   }, [selfieStep]);
   ```

**Why:** React state updates are async — the DOM does not update until after the current call stack. Setting `srcObject` before the state change is processed means `videoRef.current` is still null (element not rendered yet).

**How to apply:** Any React component that conditionally renders a `<video>` and needs to attach a MediaStream to it.
