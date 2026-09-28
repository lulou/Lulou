const VOICE_PREFIX = "__VOICE__:";

export function voiceUploadPath(matchId: string, senderId: string, requestId: string): string {
  // The sender folder makes otherwise identical request IDs independent.
  return `${matchId}/${senderId}/voice_${requestId}.m4a`;
}

export function voiceContentForWrite(publicUrl: () => string): string {
  return `${VOICE_PREFIX}${publicUrl()}`;
}

export function committedVoiceMessage(
  row: { id: string; match_id: string; sender_id: string; content: string; reaction: string | null; created_at: string | null },
  matchId: string,
  senderId: string,
) {
  if (row.match_id !== matchId || row.sender_id !== senderId || !row.content.startsWith(VOICE_PREFIX)) return null;
  return {
    id: row.id, matchId: row.match_id, senderId: row.sender_id,
    content: row.content, reaction: row.reaction, createdAt: row.created_at,
  };
}
