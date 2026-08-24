export const SPIN_ROOM_TIMING = {
  firstMessageMs: 1_300,
  finalMessageMs: 2_600,
  growStartMs: 4_300,
  growDurationMs: 3_000,
  resultHandoffMs: 8_200,
  controlsDelayMs: 700,
  haloAcknowledgementMs: 900,
} as const;

export function canStartHaloSend({
  hasWinner,
  haloSent,
  mutationPending,
  inFlight,
}: {
  hasWinner: boolean;
  haloSent: boolean;
  mutationPending: boolean;
  inFlight: boolean;
}): boolean {
  return hasWinner && !haloSent && !mutationPending && !inFlight;
}