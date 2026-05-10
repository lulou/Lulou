/**
 * call-debug.ts — Singleton call debug log store.
 *
 * Written to by use-webrtc.ts at every key step.
 * Read reactively by CallDebugPanel via callDebug.subscribe().
 * Also exposed on window.callDebugLog for manual console inspection.
 *
 * Console shortcut (paste into browser console after a call attempt):
 *   copy(JSON.stringify(window.callDebugLog, null, 2))
 *   window.callDebugLog.events.map(e => e.t + " " + e.msg).join("\n")
 *   window.webrtcLogs.join("\n")
 */

export interface CallDebugEvent {
  t: string;
  msg: string;
}

export interface CallDebugLog {
  callId: string;
  sessionId: string;
  myUserId: string;
  isCaller: boolean;
  isVideo: boolean;
  startedAt: string;

  mediaStatus: "pending" | "ok" | "error";
  mediaError: string;
  mediaTier: number;

  channelStatus: "idle" | "subscribing" | "subscribed" | "error" | "timeout";
  channelError: string;

  readySent: number;
  readyReceived: boolean;
  offerCreated: boolean;
  offerSent: boolean;
  offerReceived: boolean;
  rollbackCount: number;
  answerReceived: boolean;
  answerSent: boolean;

  iceSent: number;
  iceReceived: number;
  iceTypes: { host: number; srflx: number; relay: number };
  iceHasTurn: boolean;

  signalingStates: string[];
  iceStates: string[];
  pcStates: string[];

  outcome: "pending" | "connected" | "failed" | "ended" | "cancelled";
  failureReason: string;
  connectedAt: string;

  events: CallDebugEvent[];
}

function _emptyLog(): CallDebugLog {
  return {
    callId: "", sessionId: "", myUserId: "", isCaller: false, isVideo: false, startedAt: "",
    mediaStatus: "pending", mediaError: "", mediaTier: 0,
    channelStatus: "idle", channelError: "",
    readySent: 0, readyReceived: false,
    offerCreated: false, offerSent: false, offerReceived: false,
    rollbackCount: 0, answerReceived: false, answerSent: false,
    iceSent: 0, iceReceived: 0, iceTypes: { host: 0, srflx: 0, relay: 0 }, iceHasTurn: false,
    signalingStates: [], iceStates: [], pcStates: [],
    outcome: "pending", failureReason: "", connectedAt: "",
    events: [],
  };
}

type Listener = () => void;
const _listeners = new Set<Listener>();
let _log: CallDebugLog = _emptyLog();

function _notify() {
  _listeners.forEach(l => l());
}

function _ts(): string {
  return new Date().toISOString().slice(11, 23);
}

function _sync() {
  if (typeof window !== "undefined") (window as any).callDebugLog = _log;
}

export const callDebug = {
  get(): CallDebugLog { return _log; },

  /** Call at the start of each call attempt to clear state from the previous call. */
  reset(partial: Partial<CallDebugLog> = {}) {
    _log = { ..._emptyLog(), ...partial, events: [] };
    _sync();
    _notify();
  },

  /** Merge partial fields into the current log and notify subscribers. */
  update(partial: Partial<CallDebugLog>) {
    Object.assign(_log, partial);
    _sync();
    _notify();
  },

  /** Append a timestamped event to the event log. */
  event(msg: string) {
    _log.events.push({ t: _ts(), msg });
    if (_log.events.length > 150) _log.events.splice(0, _log.events.length - 150);
    _sync();
    _notify();
  },

  /** Subscribe to any change. Returns an unsubscribe function. */
  subscribe(l: Listener): () => void {
    _listeners.add(l);
    return () => _listeners.delete(l);
  },
};
