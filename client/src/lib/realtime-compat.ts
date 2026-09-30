import { supabase, supabasePublicRealtime } from "./supabase";

export const PRIVATE_CLIENT_PUBLIC_MARKER = "__lulouPrivateClient";
export const BRIDGE_DUAL_PUBLIC_MARKER = "__lulouBridgeDualPublic";

type BroadcastChannel = ReturnType<typeof supabase.channel>;
type BroadcastConfig = NonNullable<
  Parameters<typeof supabase.channel>[1]
>["config"]["broadcast"];
type StatusCallback = (status: string, error?: Error) => void;
type CompatibilityTransport = "private" | "public";

export interface RealtimeCompatibilityPair {
  privateChannel: BroadcastChannel;
  publicChannel: BroadcastChannel;
  pendingPublicSends: Array<{
    event: string;
    payload: Record<string, unknown>;
    createdAt: number;
  }>;
}

interface ChannelEntry {
  topic: string;
  channel: BroadcastChannel;
  channelOptions: NonNullable<Parameters<typeof supabase.channel>[1]>;
  transport: CompatibilityTransport;
  leases: Set<CompatibilityLease>;
  boundEvents: Set<string>;
  subscribeStarted: boolean;
  subscribeRequested: boolean;
  retiring: boolean;
  pendingSends: Array<{
    message: Parameters<BroadcastChannel["send"]>[0];
    options?: Parameters<BroadcastChannel["send"]>[1];
    resolve: (status: string) => void;
    reject: (error: unknown) => void;
  }>;
}

interface CompatibilityLease {
  pair: RealtimeCompatibilityPair;
  privateEntry: ChannelEntry;
  publicEntry: ChannelEntry;
  active: boolean;
  privateListeners: Map<string, Set<(message: any) => void>>;
  publicListeners: Map<string, Set<(message: any) => void>>;
  privateStatusCallbacks: Set<StatusCallback>;
  publicStatusCallbacks: Set<StatusCallback>;
}

const PUBLIC_SEND_QUEUE_TTL_MS = 5_000;
const PUBLIC_SEND_QUEUE_LIMIT = 48;

// RealtimeClient.channel() returns the existing channel for a duplicate topic.
// Keep an explicit lease pool as well, so topic sharing is deliberate and the
// underlying channel is subscribed/removed once per set of consumers.
const privateChannels = new Map<string, ChannelEntry>();
const publicChannels = new Map<string, ChannelEntry>();
const leasesByPair = new WeakMap<RealtimeCompatibilityPair, CompatibilityLease>();

function getOrCreateChannel(
  topic: string,
  transport: CompatibilityTransport,
  broadcast?: BroadcastConfig,
): ChannelEntry {
  const pool = transport === "private" ? privateChannels : publicChannels;
  const existing = pool.get(topic);
  if (existing) return existing;

  // Chat echoes are required by useRealtimeMessages. The unread-counts hook
  // may acquire this shared channel first, so enforce self:true from creation.
  const effectiveBroadcast = topic.startsWith("chat:")
    ? { ...broadcast, self: true }
    : broadcast;
  const config = {
    private: transport === "private",
    ...(effectiveBroadcast ? { broadcast: effectiveBroadcast } : {}),
  };
  const channelOptions = { config };
  const client = transport === "private" ? supabase : supabasePublicRealtime;
  const entry: ChannelEntry = {
    topic,
    channel: client.channel(topic, channelOptions),
    channelOptions,
    transport,
    leases: new Set(),
    boundEvents: new Set(),
    subscribeStarted: false,
    subscribeRequested: false,
    retiring: false,
    pendingSends: [],
  };
  pool.set(topic, entry);
  return entry;
}

/** Create a private authoritative transport and an isolated public legacy transport. */
export function createRealtimeCompatibilityPair(
  topic: string,
  broadcast?: BroadcastConfig,
): RealtimeCompatibilityPair {
  const privateEntry = getOrCreateChannel(topic, "private", broadcast);
  const publicEntry = getOrCreateChannel(topic, "public", broadcast);
  const pair: RealtimeCompatibilityPair = {
    privateChannel: privateEntry.channel,
    publicChannel: publicEntry.channel,
    pendingPublicSends: [],
  };
  const lease: CompatibilityLease = {
    pair,
    privateEntry,
    publicEntry,
    active: true,
    privateListeners: new Map(),
    publicListeners: new Map(),
    privateStatusCallbacks: new Set(),
    publicStatusCallbacks: new Set(),
  };
  privateEntry.leases.add(lease);
  publicEntry.leases.add(lease);
  leasesByPair.set(pair, lease);
  pair.privateChannel = createLeaseChannelView(privateEntry, lease);
  pair.publicChannel = createLeaseChannelView(publicEntry, lease);
  return pair;
}

function createLeaseChannelView(entry: ChannelEntry, lease: CompatibilityLease): BroadcastChannel {
  let view: BroadcastChannel;
  view = new Proxy(entry.channel, {
    get(target, property) {
      if (property === "on") {
        return (type: string, filter: any, callback: (message: any) => void) => {
          if (!lease.active) return view;
          if (type === "broadcast" && typeof filter?.event === "string") {
            addLeaseListener(entry, lease, filter.event, callback);
            return view;
          }
          const result = target.on(type as any, filter, callback);
          return result === target ? view : result;
        };
      }
      if (property === "subscribe") {
        return (callback?: StatusCallback) => {
          if (lease.active) subscribeCompatibilityEntry(entry, lease, callback);
          return view;
        };
      }
      if (property === "send") {
        return (message: Parameters<BroadcastChannel["send"]>[0], options?: Parameters<BroadcastChannel["send"]>[1]) =>
          sendThroughEntry(entry, lease, message, options);
      }
      if (property === "state" && entry.retiring) return "closed";
      const channel = entry.channel;
      const value = Reflect.get(channel, property, channel);
      return typeof value === "function" ? value.bind(channel) : value;
    },
  });
  return view;
}

/**
 * Attach the same event handler to both generations. Marked public copies are
 * redundant with the private copy, while unmarked copies remain the legacy path.
 */
export function onCompatibilityBroadcast(
  pair: RealtimeCompatibilityPair,
  event: string,
  handler: (message: any) => void,
): RealtimeCompatibilityPair {
  const lease = getActiveLease(pair);
  if (!lease) return pair;
  addLeaseListener(lease.privateEntry, lease, event, handler);
  addLeaseListener(lease.publicEntry, lease, event, handler);
  return pair;
}

/** Attach a compatibility listener when the private listener is already bound. */
export function onCompatibilityPublicBroadcast(
  pair: RealtimeCompatibilityPair,
  event: string,
  handler: (message: any) => void,
): RealtimeCompatibilityPair {
  const lease = getActiveLease(pair);
  if (!lease) return pair;
  addLeaseListener(lease.publicEntry, lease, event, handler);
  return pair;
}

function addLeaseListener(
  entry: ChannelEntry,
  lease: CompatibilityLease,
  event: string,
  handler: (message: any) => void,
): void {
  const listeners = entry.transport === "private" ? lease.privateListeners : lease.publicListeners;
  let eventListeners = listeners.get(event);
  if (!eventListeners) {
    eventListeners = new Set();
    listeners.set(event, eventListeners);
  }
  eventListeners.add(handler);

  bindChannelEvent(entry, event);
}

function bindChannelEvent(entry: ChannelEntry, event: string): void {
  if (entry.retiring || entry.boundEvents.has(event)) return;
  entry.boundEvents.add(event);
  const boundChannel = entry.channel;
  boundChannel.on("broadcast", { event }, (message: any) => {
    if (entry.retiring || entry.channel !== boundChannel) return;
    for (const currentLease of [...entry.leases]) {
      if (!currentLease.active) continue;
      const currentListeners = entry.transport === "private"
        ? currentLease.privateListeners
        : currentLease.publicListeners;
      const callbacks = currentListeners.get(event);
      if (!callbacks) continue;
      const payload = message?.payload;
      if (
        entry.transport === "public"
        && (
          payload?.[PRIVATE_CLIENT_PUBLIC_MARKER] === true
          || payload?.[BRIDGE_DUAL_PUBLIC_MARKER] === true
        )
      ) continue;
      for (const callback of [...callbacks]) {
        if (currentLease.active && currentListeners.get(event)?.has(callback)) callback(message);
      }
    }
  });
}

/** Subscribe each shared transport once and fan status out to active leases. */
export function subscribeCompatibilityPair(
  pair: RealtimeCompatibilityPair,
  onPrivateStatus?: StatusCallback,
  onPublicStatus?: StatusCallback,
): RealtimeCompatibilityPair {
  const lease = getActiveLease(pair);
  if (!lease) return pair;
  subscribeCompatibilityEntry(lease.privateEntry, lease, onPrivateStatus);
  subscribeCompatibilityEntry(lease.publicEntry, lease, onPublicStatus);
  return pair;
}

/** Subscribe only to the best-effort legacy path (private join owns readiness). */
export function subscribeCompatibilityPublic(
  pair: RealtimeCompatibilityPair,
  onStatus?: StatusCallback,
): RealtimeCompatibilityPair {
  const lease = getActiveLease(pair);
  if (!lease) return pair;
  subscribeCompatibilityEntry(lease.publicEntry, lease, onStatus);
  return pair;
}

function subscribeCompatibilityEntry(
  entry: ChannelEntry,
  lease: CompatibilityLease,
  callback?: StatusCallback,
): void {
  const callbacks = entry.transport === "private"
    ? lease.privateStatusCallbacks
    : lease.publicStatusCallbacks;
  const isNewCallback = !!callback && !callbacks.has(callback);
  if (callback) callbacks.add(callback);
  entry.subscribeRequested = true;

  if (entry.retiring) return;

  if (entry.channel.state === "joined") {
    entry.subscribeStarted = true;
    entry.subscribeRequested = false;
    if (entry.transport === "public" && lease.pair.pendingPublicSends.length) {
      flushPendingPublicSends(lease.pair);
    }
    if (isNewCallback) callback?.("SUBSCRIBED");
    return;
  }

  startChannelSubscription(entry);
}

function startChannelSubscription(entry: ChannelEntry): void {
  if (entry.retiring) return;
  if (entry.channel.state === "joined") {
    entry.subscribeStarted = true;
    entry.subscribeRequested = false;
    notifyLeasesOfStatus(entry, "SUBSCRIBED");
    return;
  }
  if (entry.subscribeStarted) return;
  entry.subscribeStarted = true;
  entry.subscribeRequested = false;
  const subscribedChannel = entry.channel;
  subscribedChannel.subscribe((status: string, error?: Error) => {
    if (entry.retiring || entry.channel !== subscribedChannel) return;
    notifyLeasesOfStatus(entry, status, error);
  });
}

function notifyLeasesOfStatus(entry: ChannelEntry, status: string, error?: Error): void {
  if (entry.retiring) return;
  if (status === "SUBSCRIBED") {
    flushPendingChannelSends(entry);
  } else if (
    (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED")
    && entry.pendingSends.length
  ) {
    rejectPendingChannelSends(entry, error ?? new Error(`REALTIME_CHANNEL_${status}`));
  }

  for (const lease of [...entry.leases]) {
    if (!lease.active) continue;
    if (entry.transport === "public") {
      if (status === "SUBSCRIBED") flushPendingPublicSends(lease.pair);
      else if (status === "CLOSED") lease.pair.pendingPublicSends = [];
    }
    const callbacks = entry.transport === "private"
      ? lease.privateStatusCallbacks
      : lease.publicStatusCallbacks;
    for (const callback of [...callbacks]) {
      if (lease.active && callbacks.has(callback)) callback(status, error);
    }
  }
}

/**
 * Send privately first, then best-effort send a marked public copy. Public
 * failures never affect the authoritative private send.
 */
export function sendCompatibilityBroadcast(
  pair: RealtimeCompatibilityPair,
  event: string,
  payload: Record<string, unknown>,
): Promise<string> {
  const lease = getActiveLease(pair);
  if (!lease) return Promise.reject(new Error("REALTIME_COMPATIBILITY_LEASE_RELEASED"));

  const publicState = pair.publicChannel.state;
  if (publicState === "joined") sendPublicBroadcast(pair, event, payload);
  else if (publicState !== "errored") {
    if (pair.pendingPublicSends.length >= PUBLIC_SEND_QUEUE_LIMIT) pair.pendingPublicSends.shift();
    pair.pendingPublicSends.push({ event, payload: { ...payload }, createdAt: Date.now() });
    if (lease.publicEntry.retiring) lease.publicEntry.subscribeRequested = true;
  }

  return sendThroughEntry(lease.privateEntry, lease, {
    type: "broadcast",
    event,
    payload,
  });
}

function flushPendingPublicSends(pair: RealtimeCompatibilityPair): void {
  if (pair.publicChannel.state !== "joined") return;
  const now = Date.now();
  const queued = pair.pendingPublicSends.splice(0);
  for (const send of queued) {
    if (now - send.createdAt > PUBLIC_SEND_QUEUE_TTL_MS) continue;
    sendPublicBroadcast(pair, send.event, send.payload);
  }
}

function sendPublicBroadcast(
  pair: RealtimeCompatibilityPair,
  event: string,
  payload: Record<string, unknown>,
): void {
  const publicPayload = { ...payload, [PRIVATE_CLIENT_PUBLIC_MARKER]: true };
  void pair.publicChannel.send({
    type: "broadcast",
    event,
    payload: publicPayload,
  }).then((status) => {
    if (status !== "ok") {
      console.warn("[REALTIME_COMPAT] public compatibility send failed", { event, status });
    }
  }).catch((error: any) => {
    console.warn("[REALTIME_COMPAT] public compatibility send failed", {
      event,
      error: error?.message ?? String(error),
    });
  });
}

function sendThroughEntry(
  entry: ChannelEntry,
  lease: CompatibilityLease,
  message: Parameters<BroadcastChannel["send"]>[0],
  options?: Parameters<BroadcastChannel["send"]>[1],
): Promise<string> {
  if (!lease.active) return Promise.reject(new Error("REALTIME_COMPATIBILITY_LEASE_RELEASED"));
  if (!entry.retiring) {
    return options === undefined
      ? entry.channel.send(message)
      : entry.channel.send(message, options);
  }

  entry.subscribeRequested = true;
  return new Promise<string>((resolve, reject) => {
    entry.pendingSends.push({ message, options, resolve, reject });
  });
}

function flushPendingChannelSends(entry: ChannelEntry): void {
  if (entry.retiring || entry.channel.state !== "joined" || entry.pendingSends.length === 0) return;
  const pending = entry.pendingSends.splice(0);
  for (const send of pending) {
    const result = send.options === undefined
      ? entry.channel.send(send.message)
      : entry.channel.send(send.message, send.options);
    void result.then(send.resolve, send.reject);
  }
}

function rejectPendingChannelSends(entry: ChannelEntry, error: Error): void {
  const pending = entry.pendingSends.splice(0);
  for (const send of pending) send.reject(error);
}

function getActiveLease(pair: RealtimeCompatibilityPair): CompatibilityLease | null {
  const lease = leasesByPair.get(pair);
  return lease?.active ? lease : null;
}

export function removeCompatibilityPair(pair: RealtimeCompatibilityPair): void {
  const lease = getActiveLease(pair);
  if (!lease) return;

  lease.active = false;
  pair.pendingPublicSends = [];
  releaseChannelLease(lease.privateEntry, lease);
  releaseChannelLease(lease.publicEntry, lease);
}

function releaseChannelLease(entry: ChannelEntry, lease: CompatibilityLease): void {
  entry.leases.delete(lease);
  if (entry.leases.size > 0 || entry.retiring) return;

  // Leave the entry in its pool until the SDK has finished teardown. New leases
  // arriving meanwhile attach to this tombstone and are activated on a fresh
  // SDK channel only after removeChannel has completed.
  entry.retiring = true;
  entry.subscribeStarted = false;
  entry.subscribeRequested = false;
  const client = entry.transport === "private" ? supabase : supabasePublicRealtime;
  const oldChannel = entry.channel;
  void client.removeChannel(oldChannel).then((status) => {
    finishChannelRemoval(entry, oldChannel, status);
  }).catch((error: any) => {
    console.warn("[REALTIME_COMPAT] channel cleanup failed", {
      topic: entry.topic,
      transport: entry.transport,
      error: error?.message ?? String(error),
    });
    finishChannelRemoval(entry, oldChannel, "error");
  });
}

function finishChannelRemoval(
  entry: ChannelEntry,
  oldChannel: BroadcastChannel,
  status: string,
): void {
  if (!entry.retiring || entry.channel !== oldChannel) return;
  const pool = entry.transport === "private" ? privateChannels : publicChannels;
  const client = entry.transport === "private" ? supabase : supabasePublicRealtime;
  const oldChannelStillRegistered = client.getChannels().includes(oldChannel);

  if (!oldChannelStillRegistered) {
    if (entry.leases.size === 0) {
      rejectPendingChannelSends(entry, new Error("REALTIME_COMPATIBILITY_LEASE_RELEASED"));
      if (pool.get(entry.topic) === entry) pool.delete(entry.topic);
      entry.retiring = false;
      return;
    }
    entry.channel = client.channel(entry.topic, entry.channelOptions);
    entry.boundEvents.clear();
    entry.subscribeStarted = false;
  } else {
    // A failed or mocked teardown can leave the old SDK instance registered.
    // Reuse it only after teardown has settled; never race a second instance
    // against the SDK's topic cache.
    entry.subscribeStarted = entry.channel.state === "joined" || entry.channel.state === "joining";
  }

  entry.retiring = false;
  if (entry.leases.size === 0) {
    entry.subscribeRequested = false;
    rejectPendingChannelSends(entry, new Error("REALTIME_COMPATIBILITY_LEASE_RELEASED"));
    return;
  }
  for (const lease of entry.leases) {
    if (!lease.active) continue;
    const listeners = entry.transport === "private" ? lease.privateListeners : lease.publicListeners;
    for (const event of listeners.keys()) bindChannelEvent(entry, event);
  }

  if (entry.subscribeRequested || entry.pendingSends.length > 0) {
    startChannelSubscription(entry);
  } else if (entry.subscribeStarted && entry.channel.state === "joined") {
    notifyLeasesOfStatus(entry, "SUBSCRIBED");
  }
}