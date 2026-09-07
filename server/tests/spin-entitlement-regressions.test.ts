import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getFreeSpinEntitlementKey,
  isDailySpinEntitlement,
  utcWeekStartKey,
} from "../spinEligibility";

describe("Intention Wheel entitlement regressions", () => {
  it("uses one UTC daily entitlement after ten incoming eligible likes", () => {
    const now = new Date("2026-09-07T23:59:59.000Z");
    expect(isDailySpinEntitlement(9)).toBe(false);
    expect(isDailySpinEntitlement(10)).toBe(true);
    expect(getFreeSpinEntitlementKey(10, now)).toBe("daily:2026-09-07");
  });

  it("uses one Monday-based UTC weekly entitlement otherwise", () => {
    expect(utcWeekStartKey(new Date("2026-09-13T23:59:59.000Z"))).toBe("2026-09-07");
    expect(getFreeSpinEntitlementKey(9, new Date("2026-09-13T23:59:59.000Z")))
      .toBe("weekly:2026-09-07");
  });

  it("claims free entitlements atomically and counts incoming rather than outgoing likes", () => {
    const storage = readFileSync("server/storage.ts", "utf8");
    const routes = readFileSync("server/routes.ts", "utf8");

    expect(storage).toContain("ON CONFLICT DO NOTHING");
    expect(storage).toContain('return (replay.rowCount ?? 0) > 0 ? "replay" : "unavailable"');
    expect(storage).toContain("pg_advisory_xact_lock");
    expect(storage).toContain("claimPaidSpin");
    expect(storage).toContain('.eq("to_user_id", userId)');
    expect(storage).not.toContain('.eq("from_user_id", userId)\\n      .eq("type", "open")\\n      .gte("created_at", startOfDay)');
    expect(routes).toContain("claimSpinEntitlement(userId, entitlementKey, operationId)");
    expect(routes).toContain('if (freeClaim === "replay")');
    expect(routes).toContain('res.status(403).json({ message: "No spins available" })');
  });
});