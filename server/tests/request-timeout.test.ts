import { afterEach, describe, expect, it, vi } from "vitest";
import { withRequestTimeout } from "../../client/src/lib/request-timeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("withRequestTimeout", () => {
  it("resolves normally and clears its timeout", async () => {
    vi.useFakeTimers();
    const result = await withRequestTimeout(
      async () => "ready",
      10_000,
      "startup request",
    );

    expect(result).toBe("ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts and rejects a request that never settles", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const result = withRequestTimeout(
      async currentSignal => {
        signal = currentSignal;
        return new Promise<string>(() => {});
      },
      10_000,
      "onboarding state",
    );
    const rejection = expect(result).rejects.toMatchObject({
      name: "AbortError",
      message: "onboarding state timed out after 10000ms",
    });

    await vi.advanceTimersByTimeAsync(10_000);

    await rejection;
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds response-body parsing that never settles", async () => {
    vi.useFakeTimers();
    const result = withRequestTimeout(
      async () => {
        const response = {
          json: async () => new Promise<unknown>(() => {}),
        };
        return response.json();
      },
      15_000,
      "onboarding response",
    );
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });

    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("bounds an authentication refresh that never settles", async () => {
    vi.useFakeTimers();
    const result = withRequestTimeout(
      async () => {
        const unauthorized = Object.assign(new Error("Unauthorized"), { status: 401 });
        try {
          throw unauthorized;
        } catch (error) {
          if ((error as { status?: number }).status !== 401) throw error;
          await new Promise<boolean>(() => {});
          return "retried";
        }
      },
      15_000,
      "onboarding refresh",
    );
    const rejection = expect(result).rejects.toMatchObject({ name: "AbortError" });

    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(vi.getTimerCount()).toBe(0);
  });
});