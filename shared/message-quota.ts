export type QuotaMessageInput = {
  content: string;
  callStage: number;
  authoredByUser?: boolean;
};

const VOICE_NOTE_PREFIX = "__VOICE__:";

/**
 * The single quota rule for persisted chat messages.
 * User-authored text and voice notes consume one unit in quota-bearing stages.
 * All other protocol/system rows remain excluded.
 */
export function isQuotaConsumingUserMessage({
  content,
  callStage,
  authoredByUser = true,
}: QuotaMessageInput): boolean {
  if (!authoredByUser || (callStage !== 0 && callStage !== 1)) return false;
  const value = content.trim();
  return value.length > 0 && (!value.startsWith("__") || value.startsWith(VOICE_NOTE_PREFIX));
}
