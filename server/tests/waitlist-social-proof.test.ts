import { describe, expect, it } from "vitest";
import { publicWaitlistCount } from "../waitlistSocialProof";

describe("public waitlist social proof", () => {
  it("does not expose a count before 250 verified members", () => {
    expect(publicWaitlistCount(0)).toEqual({ visible: false });
    expect(publicWaitlistCount(1)).toEqual({ visible: false });
    expect(publicWaitlistCount(249)).toEqual({ visible: false });
  });

  it("returns the exact count at and above the threshold", () => {
    expect(publicWaitlistCount(250)).toEqual({ visible: true, count: 250 });
    expect(publicWaitlistCount(284)).toEqual({ visible: true, count: 284 });
  });

  it("fails closed if the database did not return a valid count", () => {
    expect(() => publicWaitlistCount(null)).toThrow();
    expect(() => publicWaitlistCount(-1)).toThrow();
    expect(() => publicWaitlistCount(Number.NaN)).toThrow();
  });
});