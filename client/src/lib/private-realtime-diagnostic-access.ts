import { useCallback, useEffect, useRef, useState } from "react";

const TEST_EMAIL = "omibalogun270+test3@gmail.com";
const VALIDATION_TIMEOUT_MS = 5000;

type Session = {
  access_token: string;
  expires_at?: number;
  user: { id: string };
};
export type DiagnosticAuth = {
  getSession(): Promise<{ data: { session: Session | null }; error: unknown }>;
  getUser(token: string): Promise<{
    data: { user: { id: string; email?: string } | null };
    error: unknown;
  }>;
};
type Grant = { userId: string; expiresAt: number };

/** Local-view permission only. Produces no server role, credential or capability. */
export async function validatePrivateRealtimeDiagnosticAccess(
  auth: DiagnosticAuth,
  userId: string | undefined,
  isCurrent: () => boolean,
): Promise<Grant | null> {
  if (!userId || !isCurrent()) return null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const current = () => !timedOut && isCurrent();
  try {
    const validation = (async (): Promise<Grant | null> => {
      const { data, error } = await auth.getSession();
      const session = data.session;
      if (!current() || error || !session?.access_token ||
          session.user.id !== userId || !session.expires_at ||
          session.expires_at * 1000 <= Date.now()) return null;
      const verified = await auth.getUser(session.access_token);
      if (!current() || verified.error ||
          verified.data.user?.id !== userId ||
          verified.data.user.email !== TEST_EMAIL) return null;
      // Reject a validation that completed after the session/account changed.
      const latest = await auth.getSession();
      if (!current() || latest.error ||
          latest.data.session?.user.id !== userId ||
          latest.data.session.access_token !== session.access_token ||
          session.expires_at * 1000 <= Date.now()) return null;
      return { userId, expiresAt: session.expires_at * 1000 };
    })();
    return await Promise.race([
      validation,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve(null); }, VALIDATION_TIMEOUT_MS);
      }),
    ]);
  } catch {
    // Never log tokens, returned user objects, or provider errors.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Each mount/open/foreground check fails closed; account changes invalidate synchronously. */
export function usePrivateRealtimeDiagnosticAccess(
  auth: DiagnosticAuth,
  userId?: string,
  userEmail?: string,
) {
  const accountKey = `${userId ?? ""}:${userEmail ?? ""}`;
  const currentAccount = useRef(accountKey);
  currentAccount.current = accountKey;
  const generation = useRef(0);
  const mounted = useRef(false);
  const [grant, setGrant] = useState<(Grant & { accountKey: string }) | null>(null);
  const [requestedOpen, setRequestedOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  const revalidate = useCallback(async () => {
    const attempt = ++generation.current;
    setGrant(null);
    setChecking(true);
    const current = () => mounted.current &&
      generation.current === attempt && currentAccount.current === accountKey &&
      document.visibilityState !== "hidden";
    const result = await validatePrivateRealtimeDiagnosticAccess(auth, userId, current);
    if (!current()) return false;
    setGrant(result ? { ...result, accountKey } : null);
    setChecking(false);
    return !!result;
  }, [auth, userId, accountKey]);

  useEffect(() => {
    mounted.current = true;
    setRequestedOpen(false);
    void revalidate();
    const visibility = () => {
      if (document.visibilityState === "hidden") {
        ++generation.current;
        setGrant(null);
      } else {
        void revalidate();
      }
    };
    const focus = () => { if (document.visibilityState !== "hidden") void revalidate(); };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      ++generation.current;
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
    };
  }, [revalidate]);

  useEffect(() => {
    if (!grant) return;
    const timer = window.setTimeout(() => {
      ++generation.current;
      setGrant(null);
      setRequestedOpen(false);
    }, Math.max(0, grant.expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [grant]);

  const allowed = !!grant && grant.accountKey === accountKey &&
    grant.userId === userId && grant.expiresAt > Date.now();
  return {
    allowed,
    checking,
    open: allowed && requestedOpen,
    requestOpen: async () => {
      setRequestedOpen(false);
      if (await revalidate()) setRequestedOpen(true);
    },
    close: () => setRequestedOpen(false),
  };
}