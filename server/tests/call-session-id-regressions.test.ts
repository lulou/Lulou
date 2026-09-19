import { describe, expect, it } from "vitest";
import { getCallSessionTimestamp } from "../../client/src/lib/call-session-id";

describe("call session timestamp parsing", () => {
  const timestamp = 1_789_800_588_148;

  it("reads the timestamp before a digit-prefixed UUID tail", () => {
    expect(getCallSessionTimestamp(
      `call-match-with-hyphens-${timestamp}-87afc35f-576d-49c0-923b-6fbf4b196f7a`,
    )).toBe(timestamp);
  });

  it("reads the timestamp before a letter-prefixed UUID tail", () => {
    expect(getCallSessionTimestamp(
      `call-match-with-hyphens-${timestamp}-a7afc35f-576d-49c0-923b-6fbf4b196f7a`,
    )).toBe(timestamp);
  });

  it("supports legacy session IDs that end at the timestamp", () => {
    expect(getCallSessionTimestamp(`call-match-with-hyphens-${timestamp}`)).toBe(timestamp);
  });

  it("does not treat a UUID fragment or malformed ID as a timestamp", () => {
    expect(getCallSessionTimestamp("call-match-87afc35f-576d-49c0-923b-123456789012")).toBeNull();
    expect(getCallSessionTimestamp("not-a-call-session")).toBeNull();
  });
});