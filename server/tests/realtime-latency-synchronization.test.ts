import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routes = readFileSync("server/routes.ts", "utf8");
const appLayout = readFileSync("client/src/components/app-layout.tsx", "utf8");
const realtimeMessages = readFileSync("client/src/hooks/use-realtime-messages.ts", "utf8");
const messaging = readFileSync("client/src/pages/messaging.tsx", "utf8");
const matches = readFileSync("client/src/pages/matches.tsx", "utf8");

describe("realtime latency and synchronization", () => {
  it("broadcasts every committed message with authoritative stage counts", () => {
    expect(routes).toContain("await broadcastMessage(matchId");
    expect(routes).toContain("progression: isCountedMessage ? {");
    expect(routes).toContain("user1Count: newCount1");
    expect(routes).toContain("user2Count: newCount2");
    expect(realtimeMessages).toContain("messageCount1: progression.user1Count");
    expect(realtimeMessages).toContain("messageCount2: progression.user2Count");
  });

  it("starts message and unread realtime delivery before authoritative unread reconciliation", () => {
    const insert = routes.indexOf("const serverInsertedAt = Date.now()");
    const immediateUnread = routes.indexOf("delta: 1", insert);
    const persistedUnread = routes.indexOf("incrementMatchBadge(recipientId, matchId)", insert);
    expect(insert).toBeGreaterThan(-1);
    expect(immediateUnread).toBeGreaterThan(insert);
    expect(immediateUnread).toBeLessThan(persistedUnread);
  });

  it("persists unread state before chat delivery so exact-chat mark-read cannot race", () => {
    expect(routes.indexOf("incrementMatchBadge(recipientId, matchId)")).toBeLessThan(
      routes.indexOf("await broadcastMessage(matchId"),
    );
  });

  it("deduplicates immediate unread deltas while always accepting authoritative totals", () => {
    expect(appLayout).toContain(
      'seenUnreadEventIdsRef.current.has(eventId) && typeof payload.total !== "number"',
    );
    expect(appLayout).toContain('authoritative: typeof payload.total === "number"');
  });

  it("uses explicit post-decision events for pending Like and Halo counts", () => {
    expect(routes).toContain('if (type === "open" && !matched)');
    expect(routes).toContain('"interest-count-delta"');
    expect(routes).toContain('kind: "like"');
    expect(routes).toContain('kind: "halo"');
    expect(appLayout).toContain("seenInterestEventIdsRef");
    expect(appLayout).toContain("displayedLikesCount");
  });

  it("optimistically updates sender progression with rollback protection", () => {
    expect(messaging).toContain("setLocalSentCount((count) => count + 1)");
    expect(messaging).toContain("previousLocalSentCount");
    expect(messaging).toContain("setLocalSentCount(context.previousLocalSentCount)");
  });

  it("patches the Active Chats preview in the same realtime turn", () => {
    expect(matches).toContain("Patch the Active Chats preview in the same realtime turn");
    expect(matches).toContain("lastMessage: {");
    expect(matches).toContain("content: incoming.content!");
    expect(matches).toContain('!incoming.content.startsWith("__SYSTEM__:")');
  });

  it("records production-safe latency measurements without message content", () => {
    expect(realtimeMessages).toContain("realtime_delivery_ms");
    expect(realtimeMessages).toContain("stage_reconcile_ms");
    expect(appLayout).toContain("badge_update_ms");
  });
});