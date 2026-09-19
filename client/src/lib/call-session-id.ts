const MIN_PLAUSIBLE_CALL_EPOCH_MS = 1_500_000_000_000;
const MAX_PLAUSIBLE_CALL_EPOCH_MS = 4_000_000_000_000;

export function getCallSessionTimestamp(sessionId: string | null | undefined): number | null {
  if (!sessionId) return null;

  const modern = sessionId.match(
    /-(\d{13})-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  const legacy = sessionId.match(/-(\d{13})$/);
  const timestampText = modern?.[1] ?? legacy?.[1];
  if (!timestampText) return null;

  const timestamp = Number(timestampText);
  return Number.isFinite(timestamp)
    && timestamp >= MIN_PLAUSIBLE_CALL_EPOCH_MS
    && timestamp <= MAX_PLAUSIBLE_CALL_EPOCH_MS
    ? timestamp
    : null;
}