import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isQuotaConsumingUserMessage } from "../../shared/message-quota";

const routes = readFileSync("server/routes.ts", "utf8");
const migration = readFileSync("supabase/migrations/consume_message_quota_once.sql", "utf8");
const matches = readFileSync("client/src/pages/matches.tsx", "utf8");
const messaging = readFileSync("client/src/pages/messaging.tsx", "utf8");

describe("message quota parity", () => {
  it("counts user-authored text and voice notes, but not system protocols", () => {
    expect(isQuotaConsumingUserMessage({ content: "hello", callStage: 1 })).toBe(true);
    expect(isQuotaConsumingUserMessage({ content: "__VOICE__:https://example.test/a.m4a", callStage: 1 })).toBe(true);
    expect(isQuotaConsumingUserMessage({ content: "__PHONE__:You called Sam", callStage: 1 })).toBe(false);
    expect(isQuotaConsumingUserMessage({ content: "__SCHEDULE__:...", callStage: 1 })).toBe(false);
    expect(isQuotaConsumingUserMessage({ content: "hello", callStage: 2 })).toBe(false);
    expect(isQuotaConsumingUserMessage({ content: "hello", callStage: 1, authoredByUser: false })).toBe(false);
  });

  it("consumes voice quota only after the authoritative message exists", () => {
    const messageInsert = migration.indexOf("INSERT INTO public.messages(id, match_id, sender_id, content)");
    const quotaInsert = migration.indexOf("INSERT INTO public.message_quota_consumptions", messageInsert);
    expect(messageInsert).toBeGreaterThan(-1);
    expect(quotaInsert).toBeGreaterThan(messageInsert);
    expect(routes).toContain("created = await createUserMessageWithQuota");
  });

  it("deduplicates quota by authoritative message id and backfills only active stage one voice notes", () => {
    expect(migration).toContain("message_id TEXT PRIMARY KEY");
    expect(migration).toContain("ON CONFLICT (message_id) DO NOTHING");
    expect(migration).toContain("COALESCE(mt.call_stage, 0) = 1");
    expect(migration).toContain("m.content LIKE '__VOICE__:%'");
  });

  it("returns and applies authoritative progression on both chat clients", () => {
    expect(routes).toContain("res.json({ success: true, message, progression })");
    expect(routes).toContain("progression: progression ? {");
    expect(matches).toContain("messageCount1: prog.user1Count");
    expect(messaging).toContain("messageCount1: prog.user1Count");
  });

  it("allows deterministic retries through the limit gate without another deduction", () => {
    expect(routes).toContain("isExistingRetry = !!existing");
    expect(routes).toContain("The locked SQL transaction below is the sole quota authority");
    expect(routes).not.toContain("if (myPreCount >= limit)");
    expect(routes).toContain("const shouldDeliver = created.inserted");
    expect(migration).toContain("IF FOUND THEN");
    expect(migration).toContain("v_quota_applied := TRUE");
  });
});