import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { validatePrivateRealtimeDiagnosticAccess, type DiagnosticAuth } from "./private-realtime-diagnostic-access";

vi.mock("./supabase", () => ({
  supabase: { realtime: { isConnected: vi.fn(() => true) } },
}));
vi.mock("../components/ui/sheet", () => ({
  Sheet: ({ children }: any) => children,
  SheetContent: ({ children }: any) => children,
  SheetHeader: ({ children }: any) => children,
  SheetTitle: ({ children }: any) => children,
  SheetDescription: ({ children }: any) => children,
}));
import { TemporaryPrivateRealtimeDiagnostic } from "../components/temporary-private-realtime-diagnostic";
import { setPrivateSessionChannel, notePrivateSessionStatus } from "./realtime-compatibility";

const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const email = "omibalogun270+test3@gmail.com";
const token = "SECRET_TEST_TOKEN_DO_NOT_RENDER";
function authFor(address = email): DiagnosticAuth {
  return {
    getSession: vi.fn().mockResolvedValue({
      data: { session: { access_token: token, expires_at: Math.floor(Date.now() / 1000) + 600, user: { id } } }, error: null,
    }),
    getUser: vi.fn().mockResolvedValue({ data: { user: { id, email: address } }, error: null }),
  };
}

describe("temporary diagnostic access", () => {
  beforeEach(() => { vi.stubGlobal("__COMMIT_HASH__", "local-test"); setPrivateSessionChannel(null); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it("accepts only the exact server-validated account and checks the token", async () => {
    const auth = authFor();
    expect(await validatePrivateRealtimeDiagnosticAccess(auth, id, () => true)).toMatchObject({ userId: id });
    expect(auth.getUser).toHaveBeenCalledWith(token);
  });
  it.each(["other@gmail.com", "omibalogun270@gmail.com", "omibalogun270+test@gmail.com",
    "omibalogun270+test30@gmail.com", "omibalogun270+test3@googlemail.com",
    "Omibalogun270+test3@gmail.com", "", "omibalogun270+test3@gmail.com "])("rejects account/alias %s", async (address) => {
    expect(await validatePrivateRealtimeDiagnosticAccess(authFor(address), id, () => true)).toBeNull();
  });
  it("rejects missing user, session, token and expired credentials", async () => {
    expect(await validatePrivateRealtimeDiagnosticAccess(authFor(), undefined, () => true)).toBeNull();
    for (const session of [null, { access_token: "", user: { id } },
      { access_token: token, expires_at: 1, user: { id } }]) {
      const auth = authFor();
      vi.mocked(auth.getSession).mockResolvedValue({ data: { session }, error: null });
      expect(await validatePrivateRealtimeDiagnosticAccess(auth, id, () => true)).toBeNull();
      expect(auth.getUser).not.toHaveBeenCalled();
    }
  });
  it("rejects invalid tokens, validation errors and mismatched server users", async () => {
    for (const response of [
      { data: { user: null }, error: new Error("invalid token") },
      { data: { user: { id: "another-user", email } }, error: null },
      { data: { user: { id, email } }, error: new Error("validation failed") },
    ]) {
      const auth = authFor();
      vi.mocked(auth.getUser).mockResolvedValue(response);
      expect(await validatePrivateRealtimeDiagnosticAccess(auth, id, () => true)).toBeNull();
    }
    const auth = authFor();
    vi.mocked(auth.getUser).mockRejectedValue(new Error("network unavailable"));
    expect(await validatePrivateRealtimeDiagnosticAccess(auth, id, () => true)).toBeNull();
  });
  it("rejects mismatched local session and changed tokens", async () => {
    const auth = authFor();
    expect(await validatePrivateRealtimeDiagnosticAccess(auth, "another-user", () => true)).toBeNull();
    const original = (await auth.getSession()).data.session!;
    vi.mocked(auth.getSession).mockResolvedValueOnce({ data: { session: original }, error: null })
      .mockResolvedValueOnce({ data: { session: { ...original, access_token: "rotated" } }, error: null });
    expect(await validatePrivateRealtimeDiagnosticAccess(auth, id, () => true)).toBeNull();
  });
  it("times out and never authorizes a late response", async () => {
    vi.useFakeTimers();
    const auth = authFor();
    let resolve!: (value: Awaited<ReturnType<DiagnosticAuth["getUser"]>>) => void;
    vi.mocked(auth.getUser).mockImplementation(() => new Promise((r) => { resolve = r; }));
    const pending = validatePrivateRealtimeDiagnosticAccess(auth, id, () => true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await pending).toBeNull();
    resolve({ data: { user: { id, email } }, error: null });
    await Promise.resolve();
    expect(auth.getSession).toHaveBeenCalledTimes(1);
  });
  it("rejects stale responses after account change or cancellation", async () => {
    const auth = authFor();
    let current = true;
    vi.mocked(auth.getUser).mockImplementation(async () => {
      current = false;
      return { data: { user: { id, email } }, error: null };
    });
    expect(await validatePrivateRealtimeDiagnosticAccess(auth, id, () => current)).toBeNull();
  });
  it("renders no evidence without authorization/open/current user", () => {
    for (const props of [{ authorized: false, open: true, userId: id },
      { authorized: true, open: false, userId: id },
      { authorized: true, open: true, userId: undefined }]) {
      expect(renderToStaticMarkup(createElement(TemporaryPrivateRealtimeDiagnostic, { ...props, onClose() {} }))).toBe("");
    }
  });
  it("retains joined evidence without exposing full IDs or tokens", () => {
    setPrivateSessionChannel({
      topic: `realtime:private-session:${id}`, state: "joined", params: { config: { private: true } },
    } as any, true);
    const channel = { topic: `realtime:private-session:${id}`, state: "joined", params: { config: { private: true } } };
    setPrivateSessionChannel(channel as any, true);
    notePrivateSessionStatus(channel as any, "SUBSCRIBED");
    const html = renderToStaticMarkup(createElement(TemporaryPrivateRealtimeDiagnostic,
      { authorized: true, open: true, userId: id, onClose() {} }));
    expect(html).toContain("PRIVATE REALTIME: JOINED");
    expect(html).toContain("local-test");
    expect(html).not.toContain(id);
    expect(html).not.toContain(token);
    expect(html).not.toContain(email);
  });
  it("contains no admin requests or transport-changing operations", () => {
    const access = readFileSync(new URL("./private-realtime-diagnostic-access.ts", import.meta.url), "utf8");
    const sheet = readFileSync(new URL("../components/temporary-private-realtime-diagnostic.tsx", import.meta.url), "utf8");
    for (const source of [access, sheet]) {
      expect(source).not.toMatch(/\/api\/admin|ADMIN_EMAIL|\.channel\s*\(|\.subscribe\s*\(|\.unsubscribe\s*\(|\.setAuth\s*\(|\.connect\s*\(|\.refreshSession\s*\(|\.sign(In|Out)\s*\(/);
    }
  });
});