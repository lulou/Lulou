import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routes = readFileSync("server/routes.ts", "utf8");
const storage = readFileSync("server/storage.ts", "utf8");
const appLayout = readFileSync("client/src/components/app-layout.tsx", "utf8");
const unreadHook = readFileSync("client/src/hooks/use-unread-counts.ts", "utf8");
const matches = readFileSync("client/src/pages/matches.tsx", "utf8");
const messaging = readFileSync("client/src/pages/messaging.tsx", "utf8");
const realtimeMessages = readFileSync("client/src/hooks/use-realtime-messages.ts", "utf8");
const pushService = readFileSync("server/pushService.ts", "utf8");

describe("authoritative unread badges", () => {
  it("persists exactly one unread item for the recipient of every successful message", () => {
    expect(routes).toContain(
      "const recipientId = match.user1Id === userId ? match.user2Id : match.user1Id",
    );
    // Normal text and voice-note routes both use the same authoritative
    // per-message badge primitive. Voice retries are gated before this path.
    expect(routes.match(/incrementMatchBadge\(recipientId, matchId\)/g)).toHaveLength(2);
    expect(routes).toContain("await broadcastMessage(matchId");
    expect(routes.indexOf("incrementMatchBadge(recipientId, matchId)")).toBeLessThan(
      routes.indexOf("await broadcastMessage(matchId"),
    );
    expect(routes).toContain('broadcastViaHttpApi(`unread:${recipientId}`, "unread-count-changed"');
    expect(routes).toContain("delta: 1");
    expect(appLayout).toContain("typeof payload.total !== \"number\" && typeof payload.delta !== \"number\"");
  });

  it("gives first-insert voice notes the text message unread/push delivery contract", () => {
    const voiceRoute = routes.slice(routes.indexOf('app.post("/api/voice-notes/send/:matchId"'));
    const insert = voiceRoute.indexOf("let shouldBroadcast = true");
    const effects = voiceRoute.slice(insert);
    expect(effects).toContain('if (shouldBroadcast) {');
    expect(effects).toContain('event: "voice_note_message_inserted"');
    expect(effects).toContain('delta: 1');
    expect(effects).toContain("incrementMatchBadge(recipientId, matchId)");
    expect(effects).toContain('event: "voice_note_unread_incremented"');
    expect(effects).toContain('event: "voice_note_realtime_received"');
    expect(effects).toContain('event: "voice_note_push_eligible"');
    expect(effects).toContain('event: "voice_note_push_sent"');
    expect(effects).toContain("buildPush.voiceMessage(senderName, matchId, badgeTotal)");
    expect(pushService).toContain('title: "Lulou"');
    expect(pushService).toContain("sent you a voice message");
    expect(effects).toContain("serverInsertedAt");
    expect(effects.indexOf("delta: 1")).toBeLessThan(effects.indexOf("incrementMatchBadge(recipientId, matchId)"));
    expect(effects.indexOf("incrementMatchBadge(recipientId, matchId)")).toBeLessThan(effects.indexOf("await broadcastMessage(matchId"));
  });

  it("does not duplicate voice unread, realtime, or push effects for idempotent retries", () => {
    const voiceRoute = routes.slice(routes.indexOf('app.post("/api/voice-notes/send/:matchId"'));
    const retryGate = voiceRoute.indexOf("shouldBroadcast = false");
    const effects = voiceRoute.slice(voiceRoute.indexOf("if (shouldBroadcast) {", retryGate));
    expect(retryGate).toBeGreaterThan(-1);
    expect(effects).toContain("incrementMatchBadge(recipientId, matchId)");
    expect(effects).toContain("isUserActiveInChat(recipientId, matchId)");
    expect(effects).toContain("isUserActiveInApp(recipientId)");
    expect(pushService).toContain("FROM app_foreground_sessions");
    expect(appLayout).toContain('apiRequest("DELETE", "/api/app/foreground")');
  });

  it("resolves the Connections badge from the persisted sum across all matches", () => {
    expect(storage).toContain("SELECT COALESCE(SUM(count), 0)::int AS total");
    expect(appLayout).toContain('queryKey: ["/api/messages/unread-count"]');
    expect(appLayout).toContain("const unreadMessageCount = Math.max(0, unreadData?.total ?? 0)");
    expect(appLayout).not.toContain("lulou_seen_connections");
    expect(appLayout).not.toContain("newConnectionsBadge");
  });

  it("combines pending normal Likes and Halos without counting outgoing activity", () => {
    expect(appLayout).toContain('queryKey: ["/api/who-liked-you"]');
    expect(appLayout).toContain('queryKey: ["/api/wheel/sparks"]');
    expect(appLayout).toContain("const likesCount = normalLikesCount + haloCount");
    expect(appLayout).toContain("filter: `to_user_id=eq.${user.id}`");
    expect(appLayout).toContain('type === "open"');
    expect(appLayout).toContain('type === "wheel_connection"');
  });

  it("clears only the opened or actively visible match through the production API client", () => {
    expect(routes).toContain("resetMatchBadge(userId, matchId)");
    expect(storage).toContain("WHERE user_id = ${userId} AND match_id = ${matchId}");
    expect(unreadHook).toContain('apiRequest("POST", `/api/messages/${matchId}/mark-read`)');
    expect(matches).toContain('apiRequest("POST", `/api/messages/${selectedMatch.id}/mark-read`)');
    expect(messaging).toContain('apiRequest("POST", `/api/messages/${matchId}/mark-read`)');
    expect(unreadHook).toContain("if (senderId === userId) return");
    expect(messaging).toContain("handleVisibleRealtimeMessage");
    expect(realtimeMessages).toContain("onNewMessageRef.current?.(newMsg)");
    expect(realtimeMessages).toContain("handledMessageIdsRef");
  });

  it("caps both navigation badges at 99+", () => {
    expect(appLayout).toContain('displayedLikesCount > 99 ? "99+" : displayedLikesCount');
    expect(appLayout).toContain('unreadMessageCount > 99 ? "99+" : unreadMessageCount');
  });
});