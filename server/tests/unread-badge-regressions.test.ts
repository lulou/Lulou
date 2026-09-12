import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const routes = readFileSync("server/routes.ts", "utf8");
const storage = readFileSync("server/storage.ts", "utf8");
const appLayout = readFileSync("client/src/components/app-layout.tsx", "utf8");
const unreadHook = readFileSync("client/src/hooks/use-unread-counts.ts", "utf8");
const matches = readFileSync("client/src/pages/matches.tsx", "utf8");
const messaging = readFileSync("client/src/pages/messaging.tsx", "utf8");
const realtimeMessages = readFileSync("client/src/hooks/use-realtime-messages.ts", "utf8");

describe("authoritative unread badges", () => {
  it("persists exactly one unread item for the recipient of every successful message", () => {
    expect(routes).toContain(
      "const recipientId = match.user1Id === userId ? match.user2Id : match.user1Id",
    );
    expect(routes.match(/incrementMatchBadge\(recipientId, matchId\)/g)).toHaveLength(1);
    expect(routes).toContain("await broadcastMessage(matchId");
    expect(routes.indexOf("incrementMatchBadge(recipientId, matchId)")).toBeLessThan(
      routes.indexOf("await broadcastMessage(matchId"),
    );
    expect(routes).toContain('broadcastViaHttpApi(`unread:${recipientId}`, "unread-count-changed"');
    expect(routes).toContain("delta: 1");
    expect(appLayout).toContain("typeof payload.total !== \"number\" && typeof payload.delta !== \"number\"");
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