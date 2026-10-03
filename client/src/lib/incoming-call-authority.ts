import { CALL_STALE_RINGING_MS } from "../../../shared/call-lifecycle";

export type IncomingCallCandidate = {
  matchId: string;
  callSessionId: string;
  callerId: string;
  calleeId: string;
};

export type IncomingCallVerification = {
  valid: boolean;
  status?: string;
  matchId?: string;
  callSessionId?: string;
  callerId?: string;
  calleeId?: string;
  ageMs?: number;
  reason?: string;
};

export type IncomingCallGrant = IncomingCallCandidate & {
  generation: number;
  expiresAt: number;
};

type Listener = (sessionId: string, reason: string) => void;

/**
 * An armed session is not incoming-call authority. Only a successful, exact
 * server verification can issue a short-lived grant. This store is deliberately
 * independent of React, polling and Realtime transport.
 */
export class IncomingCallAuthority {
  private userId: string | null = null;
  private identityKey = "";
  private generation = 0;
  private foreground = true;
  private grants = new Map<string, IncomingCallGrant>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, Promise<IncomingCallGrant | null>>();
  private terminalSessions = new Set<string>();
  private latestByMatch = new Map<string, string>();
  private recoveryCandidates = new Map<string, IncomingCallGrant>();
  private listeners = new Set<Listener>();

  constructor(private now: () => number = Date.now) {}

  setIdentity(userId: string | null, sessionKey = ""): void {
    if (this.userId === userId && this.identityKey === sessionKey) return;
    if (this.userId !== userId) this.recoveryCandidates.clear();
    this.userId = userId;
    this.identityKey = sessionKey;
    this.invalidate("identity_changed");
  }

  getGeneration(): number { return this.generation; }

  /** Also called at authentication resets even if the account ID is unchanged. */
  invalidate(reason: string): void {
    for (const grant of this.grants.values()) {
      if (grant.calleeId === this.userId && grant.expiresAt > this.now()
        && !this.terminalSessions.has(`${grant.matchId}:${grant.callSessionId}`)) {
        this.recoveryCandidates.set(grant.callSessionId, grant);
      }
    }
    this.generation++;
    this.pending.clear();
    this.latestByMatch.clear();
    for (const sid of [...this.grants.keys()]) this.revoke(sid, reason);
    // Pending verification may be the only state at an auth-generation reset.
    // Notify React even when there was no granted session to revoke.
    for (const listener of this.listeners) listener("", "generation_changed");
  }

  getRecoveryCandidates(): IncomingCallCandidate[] {
    return [...this.recoveryCandidates.values()]
      .filter(grant => grant.calleeId === this.userId && grant.expiresAt > this.now()
        && !this.terminalSessions.has(`${grant.matchId}:${grant.callSessionId}`))
      .map(({ matchId, callSessionId, callerId, calleeId }) => ({ matchId, callSessionId, callerId, calleeId }));
  }

  setForeground(visible: boolean): void {
    if (this.foreground === visible) return;
    this.foreground = visible;
    this.invalidate(visible ? "foreground_revalidation" : "background");
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): IncomingCallGrant[] {
    return [...this.grants.values()].filter(grant => this.get(grant.callSessionId));
  }

  get(sessionId: string | null | undefined, expected?: Partial<IncomingCallCandidate>): IncomingCallGrant | null {
    if (!sessionId || !this.foreground) return null;
    const grant = this.grants.get(sessionId);
    if (!grant || grant.generation !== this.generation || grant.calleeId !== this.userId || this.now() >= grant.expiresAt) return null;
    if (expected && Object.entries(expected).some(([key, value]) => grant[key as keyof IncomingCallCandidate] !== value)) return null;
    return grant;
  }

  revoke(sessionId: string, reason: string): void {
    const timer = this.timers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(sessionId);
    this.grants.delete(sessionId);
    for (const listener of this.listeners) listener(sessionId, reason);
  }

  terminal(matchId: string, sessionId: string, reason = "terminal"): void {
    if (!sessionId) return;
    const owned = this.grants.get(sessionId);
    if (owned && owned.matchId !== matchId) return;
    this.terminalSessions.add(`${matchId}:${sessionId}`);
    this.recoveryCandidates.delete(sessionId);
    this.revoke(sessionId, reason);
  }

  async verify(
    candidate: IncomingCallCandidate,
    verifier: (candidate: IncomingCallCandidate) => Promise<IncomingCallVerification | null>,
    isCurrent: () => boolean = () => true,
  ): Promise<IncomingCallGrant | null> {
    const { matchId, callSessionId, callerId, calleeId } = candidate;
    if (![matchId, callSessionId, callerId, calleeId].every(value => typeof value === "string" && value.length > 0)
      || callerId === calleeId || calleeId !== this.userId || !this.foreground
      || this.terminalSessions.has(`${matchId}:${callSessionId}`) || !isCurrent()) return null;
    const owned = this.get(callSessionId);
    if (owned && Object.entries(candidate).some(([key, value]) => owned[key as keyof IncomingCallCandidate] !== value)) return null;
    const generation = this.generation;
    const key = `${generation}:${matchId}:${callSessionId}:${callerId}:${calleeId}`;
    this.latestByMatch.set(matchId, callSessionId);
    const existing = this.pending.get(key);
    if (existing) return existing;
    const requestStartedAt = this.now();
    // Retain a prompt, not a grant, when authentication changes during its
    // first verification. Recovery always makes a new server request; this
    // metadata cannot authorize UI/audio and never survives an account change.
    const retained = this.recoveryCandidates.get(callSessionId);
    this.recoveryCandidates.set(callSessionId, {
      ...candidate, generation,
      expiresAt: Math.min(retained?.expiresAt ?? Number.POSITIVE_INFINITY, owned?.expiresAt ?? Number.POSITIVE_INFINITY,
        requestStartedAt + CALL_STALE_RINGING_MS),
    });
    const task = (async () => {
      let result: IncomingCallVerification | null;
      try { result = await verifier(candidate); } catch { result = null; }
      if (generation !== this.generation || calleeId !== this.userId || !this.foreground || !isCurrent()
        || this.latestByMatch.get(matchId) !== callSessionId
        || this.terminalSessions.has(`${matchId}:${callSessionId}`)) return null;
      if (!result) {
        // Unavailability never authorizes a new ring. Revoke any previous grant
        // for this session; a subsequent prompt/resume may safely retry.
        this.revoke(callSessionId, "verification_unavailable");
        return null;
      }
      const age = result.ageMs;
      if (result.valid !== true) {
        if (result.reason === "verification_unavailable") {
          this.revoke(callSessionId, "verification_unavailable");
          return null;
        }
        this.terminal(matchId, callSessionId, result.reason === "already_answered" ? "answered" : result.reason ?? "verification_rejected");
        return null;
      }
      if ((result.matchId !== undefined && result.matchId !== matchId)
        || result.callSessionId !== callSessionId || result.callerId !== callerId || result.calleeId !== calleeId
      ) {
        // An untrusted event with the wrong identity is not permission to
        // cancel/tombstone a different legitimately verified call.
        return null;
      }
      if (result.status !== "ringing" || typeof age !== "number" || !Number.isFinite(age) || age < 0 || age >= CALL_STALE_RINGING_MS) {
        this.terminal(matchId, callSessionId, result.reason ?? "verification_rejected");
        return null;
      }
      // Subtract the whole request duration, conservatively, rather than
      // extending the server's 90-second window by network/queue latency.
      const previous = this.get(callSessionId, candidate);
      const expiresAt = Math.min(
        requestStartedAt + CALL_STALE_RINGING_MS - age,
        previous?.expiresAt ?? Number.POSITIVE_INFINITY,
      );
      if (expiresAt <= this.now()) {
        this.terminal(matchId, callSessionId, "expired");
        return null;
      }
      const previousSid = [...this.grants.values()].find(grant => grant.matchId === matchId && grant.callSessionId !== callSessionId)?.callSessionId;
      if (previousSid) this.revoke(previousSid, "session_replaced");
      // Repeated verified rerings refresh the same ownership object, rather
      // than making pending audio promises look like a replacement call.
      const grant = previous ?? { ...candidate, generation, expiresAt };
      grant.expiresAt = expiresAt;
      const timer = this.timers.get(callSessionId);
      if (timer !== undefined) clearTimeout(timer);
      this.grants.set(callSessionId, grant);
      this.timers.set(callSessionId, setTimeout(() => this.terminal(matchId, callSessionId, "expired"), expiresAt - this.now()));
      for (const listener of this.listeners) listener(callSessionId, "verified");
      return grant;
    })();
    this.pending.set(key, task);
    try { return await task; } finally {
      if (this.pending.get(key) === task) this.pending.delete(key);
    }
  }
}

export const incomingCallAuthority = new IncomingCallAuthority();