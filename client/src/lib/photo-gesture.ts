export interface PhotoGestureState {
  pointerId: number | null;
  dirLocked: boolean | null;
  startX: number;
  startY: number;
}

export function shouldPreventPhotoTouchMove(
  gesture: PhotoGestureState,
  touch: { clientX: number; clientY: number } | undefined,
): boolean {
  // A touchmove can arrive after the photo viewer mounts or updates while a
  // page swipe is already in progress. Without an active pointer origin,
  // comparing against the default (0, 0) can misclassify that page swipe as
  // horizontal and cancel native vertical scrolling.
  if (gesture.pointerId === null || !touch) return false;
  if (gesture.dirLocked === true) return true;
  if (gesture.dirLocked !== null) return false;

  const dx = Math.abs(touch.clientX - gesture.startX);
  const dy = Math.abs(touch.clientY - gesture.startY);
  return dx > 3 && dx > dy;
}