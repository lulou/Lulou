import { afterEach, describe, expect, it, vi } from "vitest";
import { removeStartupLaunch } from "../../client/src/components/startup-launch";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("startup launch controller", () => {
  it("reveals a React recovery screen immediately after a root render failure", () => {
    const remove = vi.fn();
    const markReactMounted = vi.fn();
    vi.stubGlobal("window", { __lulouMarkReactMounted: markReactMounted });
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => ({ remove })),
    });

    removeStartupLaunch();

    expect(markReactMounted).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
  });
});