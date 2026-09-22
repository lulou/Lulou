import { supabaseAdmin } from "./supabase";

export type CreatedQuotaMessage = {
  inserted: boolean;
  quotaApplied: boolean;
  message: {
    id: string;
    matchId: string;
    senderId: string;
    content: string;
    reaction: string | null;
    createdAt: string | null;
  };
  user1Count: number;
  user2Count: number;
  callStage: number;
};

export async function createUserMessageWithQuota(input: {
  matchId: string;
  senderId: string;
  messageId?: string;
  content: string;
  consumesQuota: boolean;
  stage0Limit: number;
}): Promise<CreatedQuotaMessage> {
  const { data, error } = await supabaseAdmin.rpc("create_user_message_with_quota", {
    p_match_id: input.matchId,
    p_sender_id: input.senderId,
    p_message_id: input.messageId ?? null,
    p_content: input.content,
    p_consumes_quota: input.consumesQuota,
    p_stage0_limit: input.stage0Limit,
  });
  if (error) throw new Error(error.message);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("Message creation returned no state");
  return {
    inserted: row.out_inserted === true,
    quotaApplied: row.out_quota_applied === true,
    message: {
      id: String(row.out_id),
      matchId: String(row.out_match_id),
      senderId: String(row.out_sender_id),
      content: String(row.out_content),
      reaction: row.out_reaction ?? null,
      createdAt: row.out_created_at ?? null,
    },
    user1Count: Number(row.out_count1 ?? 0),
    user2Count: Number(row.out_count2 ?? 0),
    callStage: Number(row.out_call_stage ?? 0),
  };
}
