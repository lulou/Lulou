import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Only used by the verified-admin caller if the reaction RPC has not yet been
 * installed. The pre-migration schema cannot make the check/write atomic, so
 * retain the server's participant and sender checks and constrain the update
 * to the message identity that was authorized.
 */
export async function reactBeforeSecurityMigration(
  admin: SupabaseClient,
  messageId: string,
  actorId: string,
  reaction: string | null,
) {
  if (reaction !== "❤️" && reaction !== null) throw new Error("Invalid reaction");
  const { data: original, error: messageError } = await admin.from("messages")
    .select("id, match_id, sender_id")
    .eq("id", messageId).maybeSingle();
  if (messageError || !original) throw new Error("Message not found");
  const { data: match, error: matchError } = await admin.from("matches")
    .select("user1_id, user2_id, status")
    .eq("id", original.match_id).maybeSingle();
  if (matchError || !match || match.status !== "active" ||
      ![match.user1_id, match.user2_id].includes(actorId) ||
      original.sender_id === actorId) {
    throw new Error("Reaction not authorized");
  }
  const { data: updated, error: updateError } = await admin.from("messages")
    .update({ reaction })
    .eq("id", messageId)
    .eq("match_id", original.match_id)
    .eq("sender_id", original.sender_id)
    .select("*").single();
  if (updateError || !updated) throw new Error("Failed to update reaction");
  return updated;
}