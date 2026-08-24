/**
 * The idle Wheel keeps the first candidate centred and places the next two
 * candidates immediately to either side. Further candidates stay mounted so
 * the full feed remains available to the spin and winner-selection logic, but
 * they are not part of the prominent idle presentation.
 */
export const IDLE_WHEEL_VISIBLE_DISTANCE = 1;

export function getWheelRestingDistance(index: number): number {
  const restingSlot = index === 0
    ? 0
    : index % 2 === 1
      ? -((index + 1) / 2)
      : index / 2;
  return Math.abs(restingSlot);
}

export function isWheelIdleCardVisible(index: number): boolean {
  return getWheelRestingDistance(index) <= IDLE_WHEEL_VISIBLE_DISTANCE;
}

export function getIdleWheelVisibleIndices(candidateCount: number): number[] {
  return Array.from({ length: Math.max(0, candidateCount) }, (_, index) => index)
    .filter(isWheelIdleCardVisible);
}