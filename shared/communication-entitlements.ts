export const FIRST_CALL_MESSAGE_THRESHOLD = 15;
export const SECOND_CALL_MESSAGE_THRESHOLD = 12;

export type CommunicationGateState = "locked" | "available" | "used_paid";
export type CommunicationGateReason =
  | "messages"
  | "waiting_for_partner"
  | "schedule"
  | "complete_first_call"
  | "used";

export type CallGate = {
  state: CommunicationGateState;
  reason?: CommunicationGateReason;
  remainingMessages: number;
};

export type VoiceNoteGate = {
  state: "locked" | "available";
  reason?: "complete_first_call";
  remainingMessages: number;
};

export type CommunicationEntitlements = {
  audio: CallGate;
  video: CallGate;
  voiceNote: VoiceNoteGate;
};

type ResolveCommunicationEntitlementsInput = {
  callStage: number | null | undefined;
  messageCount1: number | null | undefined;
  messageCount2: number | null | undefined;
  voiceNotesUnlocked?: boolean;
};

function stageProgress(
  count1: number,
  count2: number,
  threshold: number,
): Pick<CallGate, "reason" | "remainingMessages"> & { complete: boolean } {
  const deficit1 = Math.max(0, threshold - count1);
  const deficit2 = Math.max(0, threshold - count2);
  const remainingMessages = Math.max(deficit1, deficit2);
  const oneMemberComplete = deficit1 === 0 || deficit2 === 0;

  return {
    complete: remainingMessages === 0,
    remainingMessages,
    reason: oneMemberComplete ? "waiting_for_partner" : "messages",
  };
}

export function resolveCommunicationEntitlements({
  callStage,
  messageCount1,
  messageCount2,
  voiceNotesUnlocked = false,
}: ResolveCommunicationEntitlementsInput): CommunicationEntitlements {
  const stage = Math.max(0, callStage ?? 0);
  const count1 = Math.max(0, messageCount1 ?? 0);
  const count2 = Math.max(0, messageCount2 ?? 0);

  const firstCallProgress = stageProgress(
    count1,
    count2,
    FIRST_CALL_MESSAGE_THRESHOLD,
  );
  const secondCallProgress = stageProgress(
    count1,
    count2,
    SECOND_CALL_MESSAGE_THRESHOLD,
  );
  const audio: CallGate =
    stage === 0
      ? !firstCallProgress.complete
        ? {
            state: "locked",
            reason: firstCallProgress.reason,
            remainingMessages: firstCallProgress.remainingMessages,
          }
        : { state: "available", remainingMessages: 0 }
      : { state: "used_paid", reason: "used", remainingMessages: 0 };

  const video: CallGate =
    stage === 0
      ? {
          state: "locked",
          reason: "complete_first_call",
          remainingMessages: secondCallProgress.remainingMessages,
        }
      : stage === 1
        ? !secondCallProgress.complete
          ? {
              state: "locked",
              reason: secondCallProgress.reason,
              remainingMessages: secondCallProgress.remainingMessages,
            }
          : { state: "available", remainingMessages: 0 }
        : { state: "used_paid", reason: "used", remainingMessages: 0 };

  const voiceNote: VoiceNoteGate = voiceNotesUnlocked
    ? { state: "available", remainingMessages: 0 }
    : {
        state: "locked",
        reason: "complete_first_call",
        remainingMessages: 0,
      };

  return { audio, video, voiceNote };
}

export function isIncludedCallTypeAllowed(
  entitlements: CommunicationEntitlements,
  isVideo: boolean,
): boolean {
  return (isVideo ? entitlements.video : entitlements.audio).state === "available";
}