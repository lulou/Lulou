import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const html = readFileSync("client/index.html", "utf8");
const worker = readFileSync("client/public/sw.js", "utf8");

describe("installed PWA boot recovery", () => {
  it("renders a visible shell before the React module graph loads", () => {
    expect(html.indexOf('id="lulou-boot-shell"')).toBeLessThan(
      html.indexOf('<script type="module" src="/src/main.tsx">'),
    );
    expect(html).toContain("Loading…");
  });

  it("bounds pre-React startup and performs only one automatic recovery", () => {
    expect(html).toContain("var bootTimeoutMs = 20000");
    expect(html).toContain('var recoveryKey = "lulou_boot_recovery_attempted"');
    expect(html).toContain('recoverOnce("startup_timeout")');
    expect(html).toContain("Lulou couldn’t finish loading.");
  });

  it("updates the worker and clears only Lulou caches before a fresh reload", () => {
    expect(html).toContain("registration.update()");
    expect(html).toContain('key.indexOf("lulou-") === 0');
    expect(html).toContain('url.searchParams.set("boot-recovery", "1")');
    expect(html).toContain('url.searchParams.set("v", String(Date.now()))');
  });

  it("detects startup script and stylesheet load failures", () => {
    expect(html).toContain('target.tagName === "SCRIPT"');
    expect(html).toContain('target.tagName === "LINK" && target.rel === "stylesheet"');
    expect(html).toContain("new URL(assetUrl, location.href).origin === location.origin");
    expect(html).toContain('recoverOnce(isBootAsset ? "startup_asset_load"');
  });

  it("resets the recovery guard only after React replaces the boot shell", () => {
    expect(html).toContain('new MutationObserver(function (_, observer)');
    expect(html).toContain("if (!bootIsPending())");
    expect(html).toContain("sessionStorage.removeItem(recoveryKey)");
  });

  it("does not let the worker delete unrelated origin caches", () => {
    expect(worker).toContain('k.startsWith("lulou-") && k !== CACHE_NAME');
    expect(worker).not.toContain("deleting ALL caches");
  });
});