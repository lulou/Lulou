import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildRealtimeCompatibilityMessages,
  REALTIME_BRIDGE_DUAL_PUBLIC_MARKER,
  sendPublicBeforePrivate,
  type RealtimeHttpMessage,
} from "../realtime-compat";

const routes = readFileSync("server/routes.ts", "utf8");
const broadcast = routes.slice(
  routes.indexOf("async function broadcastViaHttpApi("),
  routes.indexOf("\nasync function broadcastCallEvent("),
);
type Result = { ok: boolean; status: number | null };

describe("gate-free Railway Realtime compatibility", () => {
  it("preserves the legacy public event and adds an unmodified private copy", () => {
    const payload = { type: "call:ring", callSessionId: "sid-1" };
    const messages = buildRealtimeCompatibilityMessages("call-signal:match-1", "call-signal", payload);
    expect(messages).toEqual([
      { topic: "call-signal:match-1", event: "call-signal", payload: {
        ...payload, [REALTIME_BRIDGE_DUAL_PUBLIC_MARKER]: true,
      } },
      { topic: "call-signal:match-1", event: "call-signal", payload, private: true },
    ]);
    expect(messages[1].payload).toBe(payload);
    expect(payload).not.toHaveProperty(REALTIME_BRIDGE_DUAL_PUBLIC_MARKER);
  });

  it("keeps the old installed PWA's session-ID topic public-only", () => {
    const messages = buildRealtimeCompatibilityMessages(
      "private-session:user-1", "session-replaced",
      { oldSessionId: "old-1", newSessionId: "new-1" }, ["private-session:old-1"],
    );
    expect(messages[2]).toEqual({
      topic: "private-session:old-1", event: "session-replaced",
      payload: { oldSessionId: "old-1", newSessionId: "new-1", [REALTIME_BRIDGE_DUAL_PUBLIC_MARKER]: true },
    });
    expect(messages[2]).not.toHaveProperty("private");
    expect(routes.match(/legacyPublicTopics: \[`private-session:\$\{oldSessionId\}`\]/g)).toHaveLength(2);
  });

  it("does not even start the private request before the public response", async () => {
    const batches: RealtimeHttpMessage[][] = [];
    let completePublic!: (result: Result) => void;
    const publicPending = new Promise<Result>((resolve) => { completePublic = resolve; });
    const sendBatch = vi.fn((batch: RealtimeHttpMessage[]) => {
      batches.push(batch);
      return batch[0].private ? Promise.resolve({ ok: true, status: 200 }) : publicPending;
    });
    const messages = buildRealtimeCompatibilityMessages(
      "private-session:user-1", "session-replaced", { oldSessionId: "old-1" }, ["private-session:old-1"],
    );
    const resultPromise = sendPublicBeforePrivate(messages, sendBatch, vi.fn());
    expect(batches).toHaveLength(1);
    expect(batches[0].map(({ topic }) => topic)).toEqual(["private-session:user-1", "private-session:old-1"]);
    expect(batches[0].every((message) => !message.private)).toBe(true);
    completePublic({ ok: true, status: 200 });
    expect(await resultPromise).toEqual({ ok: true, status: 200 });
    expect(batches).toHaveLength(2);
    expect(batches[1]).toEqual([messages[1]]);
  });

  it("returns public success without waiting for a rejected private response", async () => {
    let rejectPrivate!: (error: Error) => void;
    const privatePending = new Promise<Result>((_resolve, reject) => { rejectPrivate = reject; });
    const report = vi.fn();
    const sendBatch = vi.fn((batch: RealtimeHttpMessage[]) =>
      batch[0].private ? privatePending : Promise.resolve({ ok: true, status: 200 }),
    );
    const result = await sendPublicBeforePrivate(
      buildRealtimeCompatibilityMessages("chat:m1", "new-message", { id: "msg-1" }),
      sendBatch, report,
    );
    expect(result).toEqual({ ok: true, status: 200 });
    rejectPrivate(new Error("private policy denied"));
    await Promise.resolve();
    expect(report).toHaveBeenCalledWith(undefined, expect.objectContaining({ message: "private policy denied" }));
  });

  it("reports a private HTTP failure without changing public success", async () => {
    const report = vi.fn();
    const result = await sendPublicBeforePrivate(
      buildRealtimeCompatibilityMessages("call-signal:m1", "call-signal", { type: "call:ring" }),
      async (batch): Promise<Result> => batch[0].private
        ? { ok: false, status: 403 }
        : { ok: true, status: 200 },
      report,
    );
    expect(result).toEqual({ ok: true, status: 200 });
    await Promise.resolve();
    expect(report).toHaveBeenCalledWith({ ok: false, status: 403 });
  });

  it("still tries private when the independent public request fails", async () => {
    const modes: string[] = [];
    const result = await sendPublicBeforePrivate(
      buildRealtimeCompatibilityMessages("unread:u1", "unread-count-changed", { total: 1 }),
      async (batch): Promise<Result> => {
        modes.push(batch[0].private ? "private" : "public");
        return batch[0].private ? { ok: true, status: 200 } : { ok: false, status: 503 };
      },
      vi.fn(),
    );
    expect(result).toEqual({ ok: false, status: 503 });
    expect(modes).toEqual(["public", "private"]);
  });

  it("uses isolated HTTP requests, a public-only result, and bounded failures", () => {
    expect(broadcast).toContain("return sendPublicBeforePrivate(messages, sendBatch,");
    expect(broadcast).toContain("body: JSON.stringify({ messages: batch })");
    expect(broadcast).toContain('const mode = batch[0]?.private ? "private" : "public"');
    expect(broadcast).toContain("const timeout = setTimeout(() => controller.abort(), 3_000)");
    expect(broadcast).toContain("requireAdminCapability()");
    expect(broadcast).toContain("errorCategory: \"http\"");
    expect(broadcast).toContain("errorCategory: \"network\"");
    expect(routes).toContain("return broadcastViaHttpApi(channelName, \"call-signal\", event)");
    expect(routes).toContain("await broadcastViaHttpApi(channelName, \"new-message\", message)");
    expect(routes).toContain('broadcastViaHttpApi(`nav-interest:${toUserId}`');
    expect(routes).toContain('broadcastViaHttpApi(`unread:${recipientId}`');
  });
});