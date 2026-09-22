import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (path: string) => readFileSync(path, "utf8");

describe("premium startup launch regressions", () => {
  const html = read("client/index.html");
  const app = read("client/src/App.tsx");
  const callback = read("client/src/pages/auth-callback.tsx");
  const launch = read("client/src/components/startup-launch.tsx");
  const main = read("client/src/main.tsx");

  it("uses the production monogram without loading copy or a spinner", () => {
    expect(html).toContain('src="/lulou-logo-master.png"');
    expect(html).not.toContain(">Loading…<");
    expect(launch).not.toContain("Loader2");
  });

  it("uses one full-viewport safe-area-aware launch surface", () => {
    expect(html).toContain('id="lulou-boot-shell"');
    expect(html).toContain("position:fixed;inset:0");
    expect(html).toContain("env(safe-area-inset-top)");
    expect(launch).toContain('document.getElementById("lulou-boot-shell")');
    expect(launch).toContain("return null");
  });

  it("preserves one logo node through the pre-React to React handoff", () => {
    expect(html.indexOf('id="root"></div>')).toBeLessThan(html.indexOf('id="lulou-boot-shell"'));
    expect(launch).not.toContain("<img");
    expect(launch).toContain('classList.add("lulou-boot-shell--exit")');
    expect(launch).toContain("shell?.remove()");
  });

  it("stops pre-React recovery after a successful React commit", () => {
    expect(html).toContain("var reactMounted = false");
    expect(html).toContain("return !reactMounted");
    expect(html).toContain("window.__lulouMarkReactMounted = function");
    expect(launch).toContain("useLayoutEffect");
    expect(launch).toContain("markReactMounted?.()");
  });

  it("reveals the root error-boundary recovery screen immediately", () => {
    expect(app).toContain("removeStartupLaunch();");
    expect(launch).toContain('document.getElementById("lulou-boot-shell")?.remove()');
  });

  it("fades only after bootstrap resolves and reveals bounded failures", () => {
    expect(app).toContain("if (startupRouteResolved) onStartupResolved()");
    expect(app).toContain("authLoadingTimedOut ||");
    expect(app).toContain("!!sessionBootstrapFailed ||");
    expect(app).toContain("persistedOnboardingStep !== null");
    expect(app).toContain("(!isSpinning && onboardingRouteResolved)");
    expect(app).toContain("setStartupResolved(true), 230");
    expect(html).toContain("transition:opacity 220ms");
  });

  it("does not mask auth callback success or error states forever", () => {
    expect(app).toContain("<AuthCallbackPage onPresentationResolved={resolveStartup} />");
    expect(callback).toContain("onPresentationResolved?.()");
  });

  it("preserves the pre-module bounded stale-bundle recovery", () => {
    expect(html).toContain("var bootTimeoutMs = 20000");
    expect(html).toContain('recoverOnce("startup_timeout")');
    expect(html).toContain("updateWorker()");
    expect(html).toContain("clearLulouCaches()");
    expect(html).toContain("shell.remove()");
    expect(main).toContain('document.getElementById("lulou-boot-shell")?.remove()');
  });

  it("bounds onboarding state requests before revealing recovery", () => {
    expect(app).toContain("withRequestTimeout(");
    expect(app).toContain("15_000");
    const boundedOperation = app.slice(
      app.indexOf("async function fetchOnboardingState"),
      app.indexOf("// ── Email verification gate"),
    );
    expect(boundedOperation).toContain('apiRequest("GET", path, undefined, { signal })');
    expect(boundedOperation).toContain("await response.json()");
    expect(boundedOperation).toContain("await refreshAuthToken()");
  });
});