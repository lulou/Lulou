export const REALTIME_BRIDGE_DUAL_PUBLIC_MARKER = "__lulouBridgeDualPublic";

export type RealtimeHttpMessage = {
  topic: string;
  event: string;
  payload: Record<string, any>;
  private?: true;
};

/** Public topics remain available to the published PWA; the private message is additive. */
export function buildRealtimeCompatibilityMessages(
  topic: string,
  event: string,
  payload: Record<string, any>,
  legacyPublicTopics: string[] = [],
): RealtimeHttpMessage[] {
  const publicPayload = { ...payload, [REALTIME_BRIDGE_DUAL_PUBLIC_MARKER]: true };
  return [
    { topic, event, payload: publicPayload },
    { topic, event, payload, private: true },
    ...legacyPublicTopics
      .filter((legacyTopic) => legacyTopic !== topic)
      .map((legacyTopic) => ({ topic: legacyTopic, event, payload: publicPayload })),
  ];
}

/**
 * Await the public request before attempting the separate private request.
 * A private rejection, timeout, or thrown error cannot alter the public result
 * or hold up callers (including the call-ring path).
 */
export async function sendPublicBeforePrivate<T extends { ok: boolean }>(
  messages: RealtimeHttpMessage[],
  sendBatch: (batch: RealtimeHttpMessage[]) => Promise<T>,
  reportPrivateFailure: (result?: T, error?: unknown) => void,
): Promise<T> {
  const publicResult = await sendBatch(messages.filter((message) => !message.private));
  const privateMessages = messages.filter((message) => message.private);
  if (privateMessages.length) {
    try {
      void sendBatch(privateMessages).then(
        (result) => {
          if (!result.ok) reportPrivateFailure(result);
        },
        (error) => reportPrivateFailure(undefined, error),
      );
    } catch (error) {
      reportPrivateFailure(undefined, error);
    }
  }
  return publicResult;
}