import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const app = readFileSync("client/src/App.tsx", "utf8");

describe("onboarding resolver recovery regressions", () => {
  it("does not turn a transient background status error into a completed-user blocker", () => {
    expect(app).toContain("cachedOnboardingComplete && onboardingStatusUnavailable");
    expect(app).toContain("onboardingStatusUnavailable && !mayUseCompletedFallback");
    expect(app).toContain("preserving app access");
  });

  it("persists only a server-resolved app state and revokes the marker for known incomplete states", () => {
    expect(app).toContain('persistConfirmedOnboardingCompletion(user.id, persistedOnboardingStep === "app")');
    expect(app).toContain("else localStorage.removeItem(key)");
  });

  it("keeps fresh unresolved users behind the bounded recovery gate", () => {
    expect(app).toContain("(settingsIsPending || dnaIsPending) && !cachedOnboardingComplete");
    expect(app).toContain("unknown_user_after_bounded_query_retry");
  });

  it("refreshes authentication before retrying both authoritative status queries", () => {
    expect(app).toContain("fetchOnboardingState<UserSettings>");
    expect(app).toContain('}>("/api/dna/status")');
    expect(app).toContain("status !== 401");
    expect(app).toContain("await refreshAuthToken()");
    const retryBlock = app.slice(
      app.indexOf('data-testid="button-retry-onboarding-state"') - 1200,
      app.indexOf('data-testid="button-retry-onboarding-state"') + 200,
    );
    expect(retryBlock).toContain("await refreshAuthToken()");
    expect(retryBlock).toContain('queryKey: ["/api/settings", user.id]');
    expect(retryBlock).toContain('queryKey: ["dna-status-check"]');
    expect(retryBlock).toContain("if (isOnboardingRetrying) return");
  });
});