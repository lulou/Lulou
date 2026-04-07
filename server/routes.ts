import type { Express, RequestHandler } from "express";
import { createServer, type Server } from "http";
import { SupabaseStorage, mapMatch } from "./storage";
import { seedDatabase } from "./seed";
import { z } from "zod";
import type { Profile } from "@shared/schema";
import { userBenefits } from "@shared/schema";
import { supabase, supabaseAdmin, createUserClient, hasServiceRoleKey } from "./supabase";
import { db } from "./db";
import { eq, and, isNull } from "drizzle-orm";
import { getUncachableStripeClient, getStripePublishableKey } from "./stripeClient";

const serverBroadcastChannels = new Map<string, ReturnType<typeof supabase.channel>>();
const serverChannelTimers = new Map<string, ReturnType<typeof setTimeout>>();

// JWT verification cache — avoids a Supabase API call on every request
// Uses a 2-minute TTL (well within any JWT's 1h window), max 500 entries
const _jwtCache = new Map<string, { user: any; expiresAt: number }>();
const JWT_CACHE_TTL_MS = 2 * 60_000;
const JWT_CACHE_MAX = 500;
function parseJwtExp(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64").toString());
    return payload.exp ? payload.exp * 1000 : 0;
  } catch { return 0; }
}
async function verifyJwt(token: string): Promise<any | null> {
  const now = Date.now();
  const cached = _jwtCache.get(token);
  if (cached && cached.expiresAt > now) return cached.user;

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return null;

  const jwtExp = parseJwtExp(token);
  const ttlExpiry = now + JWT_CACHE_TTL_MS;
  const expiresAt = jwtExp > 0 ? Math.min(jwtExp, ttlExpiry) : ttlExpiry;
  if (_jwtCache.size >= JWT_CACHE_MAX) {
    // Evict oldest entries when cache is full
    const oldest = _jwtCache.keys().next().value;
    if (oldest) _jwtCache.delete(oldest);
  }
  _jwtCache.set(token, { user, expiresAt });
  return user;
}

async function broadcastCallEvent(matchId: string, event: Record<string, any>) {
  const channelName = `call-signal:${matchId}`;
  console.log(`[CALL_BROADCAST] Sending ${event.type} on ${channelName}`);

  const existingTimer = serverChannelTimers.get(channelName);
  if (existingTimer) clearTimeout(existingTimer);

  const existing = serverBroadcastChannels.get(channelName);
  if (existing) {
    try {
      const result = await existing.send({
        type: "broadcast",
        event: "call-signal",
        payload: event,
      });
      console.log(`[CALL_BROADCAST] Sent ${event.type} via existing channel, result=${result}`);
    } catch (err) {
      console.error(`[CALL_BROADCAST] Send failed on existing channel:`, err);
    }
    const timer = setTimeout(() => {
      supabase.removeChannel(existing);
      serverBroadcastChannels.delete(channelName);
      serverChannelTimers.delete(channelName);
      console.log(`[CALL_BROADCAST] Cleaned up server channel ${channelName}`);
    }, 30000);
    serverChannelTimers.set(channelName, timer);
    return;
  }

  try {
    const channel = supabase.channel(channelName, {
      config: { broadcast: { self: false } },
    });

    const subscribeTimeout = setTimeout(() => {
      console.error(`[CALL_BROADCAST] Subscription TIMEOUT for ${channelName} - ${event.type} NOT delivered`);
      supabase.removeChannel(channel);
    }, 8000);

    channel.subscribe((status) => {
      if (status === "SUBSCRIBED") {
        clearTimeout(subscribeTimeout);
        console.log(`[CALL_BROADCAST] Server channel ${channelName} subscribed`);
        serverBroadcastChannels.set(channelName, channel);

        channel.send({
          type: "broadcast",
          event: "call-signal",
          payload: event,
        }).then((result) => {
          console.log(`[CALL_BROADCAST] Sent ${event.type}, result=${result}`);
        });

        const timer = setTimeout(() => {
          supabase.removeChannel(channel);
          serverBroadcastChannels.delete(channelName);
          serverChannelTimers.delete(channelName);
          console.log(`[CALL_BROADCAST] Cleaned up server channel ${channelName}`);
        }, 30000);
        serverChannelTimers.set(channelName, timer);
      } else if (status === "CLOSED" || status === "CHANNEL_ERROR") {
        clearTimeout(subscribeTimeout);
        console.error(`[CALL_BROADCAST] Channel ${status} for ${event.type} - NOT delivered`);
        supabase.removeChannel(channel);
        serverBroadcastChannels.delete(channelName);
      }
    });
  } catch (err) {
    console.error(`[CALL_BROADCAST] Failed to create channel for ${event.type}:`, err);
  }
}

function getStorage(req: any): SupabaseStorage {
  const auth = req.headers.authorization;
  if (auth) {
    return new SupabaseStorage(createUserClient(auth));
  }
  return new SupabaseStorage();
}

function getAdminStorage(): SupabaseStorage {
  return new SupabaseStorage(supabaseAdmin);
}

function getCallStorage(req: any): SupabaseStorage {
  if (hasServiceRoleKey) {
    return new SupabaseStorage(supabaseAdmin);
  }
  const auth = req.headers.authorization;
  if (auth) {
    return new SupabaseStorage(createUserClient(auth));
  }
  return new SupabaseStorage(supabaseAdmin);
}

const isAuthenticated: RequestHandler = async (req: any, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }
  const token = authHeader.split(" ")[1];
  try {
    const user = await verifyJwt(token);
    if (!user) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    req.user = user;
    next();
  } catch (err: any) {
    console.error("[AUTH] MIDDLEWARE_ERROR", { CALL_ROUTE_ERROR: err?.message, path: req.path });
    return res.status(500).json({ message: `Auth check failed: ${err?.message || "unknown error"}` });
  }
};

function containsContactInfo(text: string): boolean {
  const phonePattern = /(\+?\d[\d\s\-()]{7,})/;
  if (phonePattern.test(text)) return true;
  const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
  if (emailPattern.test(text)) return true;

  const socialKeywords = [
    /\b(?:instagram|insta|ig)\b/i,
    /\b(?:snapchat|snap|sc)\b/i,
    /\b(?:twitter)\b/i,
    /\b(?:tiktok|tik\s*tok)\b/i,
    /\b(?:facebook|fb)\b/i,
    /\b(?:whatsapp|whats\s*app)\b/i,
    /\b(?:telegram|tg)\b/i,
    /\b(?:discord)\b/i,
    /\b(?:linkedin)\b/i,
    /\b(?:wechat)\b/i,
    /\b(?:signal)\s+(is|@|:)/i,
    /\b(?:kik)\b/i,
    /\b(?:viber)\b/i,
    /\b(?:line)\s+(id|is|@|:)/i,
    /\b(?:x\.com)\b/i,
  ];
  for (const pattern of socialKeywords) {
    if (pattern.test(text)) return true;
  }

  const socialUrls = [
    /(?:instagram\.com|instagr\.am)\//i,
    /(?:snapchat\.com)\//i,
    /(?:twitter\.com|x\.com)\//i,
    /(?:tiktok\.com)\//i,
    /(?:facebook\.com|fb\.com)\//i,
    /(?:wa\.me)\//i,
    /(?:t\.me)\//i,
    /(?:discord\.gg)\//i,
    /(?:linkedin\.com)\//i,
  ];
  for (const pattern of socialUrls) {
    if (pattern.test(text)) return true;
  }

  if (/(?:add me|find me|hmu|hit me up|dm me|message me|follow me|text me|call me|reach me)[\s]*(?:on|at|@)/i.test(text)) return true;
  if (/@[a-zA-Z0-9._]{3,}/.test(text)) return true;

  if (/\b(?:my\s+(?:handle|username|user\s*name|number|num|#|digits|cell|mobile))\s*(?:is|:|=)\s*/i.test(text)) return true;

  const stripped = text.replace(/[\s\-_.]/g, "");
  const digitCount = (stripped.match(/\d/g) || []).length;
  const totalLen = stripped.length;
  if (totalLen >= 7 && totalLen <= 15 && digitCount >= 7) return true;

  return false;
}

const profileBodySchema = z.object({
  firstName: z.string().min(1).max(50),
  age: z.number().int().min(18).max(99),
  gender: z.enum(["woman", "man", "non-binary", "trans woman", "trans man", "genderqueer", "genderfluid", "agender", "two-spirit", "other"]),
  datingPreference: z.enum(["women", "men", "non-binary people", "trans women", "trans men", "everyone"]),
  location: z.string().min(1).max(100),
  height: z.string().max(10).optional(),
  photos: z.array(z.string()).min(1).max(6),
  signals: z.array(z.string()).min(1).max(5),
  datingIntent: z.string().min(1),
  greenFlags: z.array(z.string()).min(3).max(4),
  connectionStyle: z.string().min(1),
  conversationStarters: z.array(z.string().max(200)).min(2).max(3).optional(),
  questions: z.array(z.string().max(200)).min(2).max(3).optional(),
  email: z.string().email().max(100).optional(),
  phoneNumber: z.string().max(20).optional(),
  locationRadius: z.number().int().min(5).max(100).optional(),
  preferredAgeMin: z.number().int().min(18).max(65).optional(),
  preferredAgeMax: z.number().int().min(18).max(65).optional(),
  photoVerified: z.boolean().optional(),
  onboardingComplete: z.boolean().optional(),
});

const profileUpdateSchema = profileBodySchema.partial();

const interactionBodySchema = z.object({
  toUserId: z.string().min(1),
  type: z.enum(["open", "close"]),
});

const messageBodySchema = z.object({
  content: z.string().min(1).max(500),
});

const AUTO_REPLIES = [
  "That's really interesting! I love hearing about that.",
  "I feel the same way. What made you realize that?",
  "That's such a thoughtful perspective. Tell me more?",
  "I really appreciate you sharing that with me.",
  "You know, I was just thinking about something similar recently.",
  "That made me smile. I like how you see things.",
  "I'd love to hear more about that over coffee sometime.",
  "That resonates with me. We seem to value similar things.",
  "You have such a genuine way of expressing yourself.",
  "I love that about you. What else are you passionate about?",
  "This conversation is really flowing. I'm enjoying getting to know you.",
  "That's beautiful. I think we'd have great conversations in person.",
  "I feel like we really connect on this. It's refreshing.",
  "I appreciate your honesty. That means a lot to me.",
  "Wow, we have more in common than I expected!",
];

function generateAutoReply(profile: Profile | undefined, msgIndex: number): string {
  if (profile?.conversationStarters && profile.conversationStarters.length > 0 && msgIndex === 0) {
    return profile.conversationStarters[0];
  }
  return AUTO_REPLIES[msgIndex % AUTO_REPLIES.length];
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.get("/api/auth/user", isAuthenticated, async (req: any, res) => {
    try {
      const user = req.user;
      res.json({
        id: user.id,
        email: user.email,
      });
    } catch (error) {
      console.error("Error fetching user:", error);
      res.status(500).json({ message: "Failed to fetch user" });
    }
  });

  app.post("/api/auth/init", isAuthenticated, async (req: any, res) => {
    // Auth is already verified by isAuthenticated middleware.
    // Profile creation is handled by the onboarding flow — we do NOT create stub
    // profiles here because a stub row with onboarding_complete=false would be
    // indistinguishable from a real profile, breaking the "profile exists → app" routing.
    console.log("AUTH_INIT: Verified session for", req.user.id);
    res.json({ ok: true });
  });

  app.get("/api/profile", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const profile = await storage.getProfile(userId);
      if (!profile) {
        return res.status(404).json({ message: "Profile not found. Please complete onboarding to create your profile." });
      }
      res.json(profile);
    } catch (error: any) {
      const errMsg = error?.message || "Unknown error";
      console.error("PROFILE_FETCH_ERROR", { userId: req.user?.id, error: errMsg, code: error?.code, details: error?.details });
      res.status(500).json({ message: `Profile load error: ${errMsg}` });
    }
  });

  app.post("/api/profile", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const parsed = profileUpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid profile data", errors: parsed.error.flatten() });
      }
      const payload = { ...parsed.data, userId };
      const result = await storage.updateProfile(userId, payload);
      res.json(result);
    } catch (error: any) {
      const errMsg = error?.message || "Failed to save profile";
      console.error("PROFILE_SAVE_ERROR", errMsg, error);
      res.status(500).json({ message: errMsg });
    }
  });

  app.get("/api/discover", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const myProfile = await storage.getProfile(userId);
      if (!myProfile) {
        console.log("[DISCOVER] No profile for userId:", userId);
        return res.json([]);
      }
      const discovered = await storage.getDiscoverProfiles(userId, myProfile.gender, myProfile.datingPreference, myProfile.preferredAgeMin || 18, myProfile.preferredAgeMax || 45);
      console.log("[DISCOVER] userId:", userId, "returned:", discovered.length, "profiles");
      res.json(discovered);
    } catch (error: any) {
      console.error("[DISCOVER] Error:", error?.message, error);
      res.status(500).json({ message: "Failed to discover profiles" });
    }
  });

  app.post("/api/interactions", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const fromUserId = req.user?.id;
      if (!fromUserId) {
        return res.status(401).json({ message: "Authenticated user id missing" });
      }
      const parsed = interactionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid interaction data" });
      }

      const { toUserId, type } = parsed.data;
      if (!toUserId) {
        return res.status(400).json({ message: "Target user id is required" });
      }

      const existing = await storage.getInteraction(fromUserId, toUserId);
      if (existing) {
        return res.status(400).json({ message: "Already interacted" });
      }

      if (type === "open") {
        const matchCount = await storage.getMatchCount(fromUserId);
        if (matchCount >= 8) {
          return res.json({ matched: false, connectionLimitReached: true });
        }
      }

      const interaction = await storage.createInteraction({ fromUserId, toUserId, type });

      let matched = false;
      if (type === "open") {
        const reverseOpen = await storage.getInteraction(toUserId, fromUserId);
        if (reverseOpen && reverseOpen.type === "open") {
          const fromCount = await storage.getMatchCount(fromUserId);
          const toCount = await storage.getMatchCount(toUserId);
          if (fromCount < 8 && toCount < 8) {
            await storage.createMatch(fromUserId, toUserId);
            matched = true;
          }
        }
      }

      res.json({ interaction, matched });
    } catch (error: any) {
      const msg = error?.message || "Failed to create interaction";
      console.error("INTERACTION_ERROR", msg, error);
      res.status(500).json({ message: msg });
    }
  });

  // Intention Wheel: directly create (or reopen) a match when user taps ❤️.
  // Unlike discovery (which requires mutual opens), this creates the match immediately.
  app.post("/api/wheel/open", isAuthenticated, async (req: any, res) => {
    try {
      const fromUserId = req.user.id;
      const { toUserId } = req.body;
      if (!toUserId || typeof toUserId !== "string") {
        return res.status(400).json({ message: "toUserId is required" });
      }
      if (fromUserId === toUserId) {
        return res.status(400).json({ message: "Cannot match with yourself" });
      }
      const storage = getStorage(req);

      // Reopen existing match if one already exists
      const existing = await storage.findMatchBetweenUsers(fromUserId, toUserId);
      if (existing) {
        console.log("[WHEEL] Reopened existing match", existing.id, "for", fromUserId, "→", toUserId);
        return res.json({ matchId: existing.id, isExisting: true });
      }

      // Enforce 8-connection limit
      const matchCount = await storage.getMatchCount(fromUserId);
      if (matchCount >= 8) {
        return res.status(400).json({ message: "You've reached your connection limit (max 8). Remove a connection to add a new one." });
      }

      const match = await storage.createMatch(fromUserId, toUserId);
      console.log("[WHEEL] Created new match", match.id, "for", fromUserId, "→", toUserId);
      res.json({ matchId: match.id, isExisting: false });
    } catch (error: any) {
      const msg = error?.message || "Failed to open match";
      console.error("[WHEEL] WHEEL_OPEN_ERROR", msg, error);
      res.status(500).json({ message: msg });
    }
  });

  app.get("/api/matches", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const userMatches = await storage.getMatchesForUser(userId);
      res.json(userMatches);
    } catch (error) {
      console.error("Error fetching matches:", error);
      res.status(500).json({ message: "Failed to fetch matches" });
    }
  });

  app.get("/api/matches/:matchId", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const match = await storage.getMatch(req.params.matchId, userId);
      if (!match) {
        return res.status(404).json({ message: "Match not found" });
      }
      res.json(match);
    } catch (error) {
      console.error("Error fetching match:", error);
      res.status(500).json({ message: "Failed to fetch match" });
    }
  });

  app.post("/api/messages/:messageId/reaction", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { messageId } = req.params;
      const { reaction } = req.body;

      if (!messageId) {
        return res.status(400).json({ message: "Missing messageId" });
      }

      const { data: msg, error: msgErr } = await storage.getMessage(messageId);
      if (msgErr || !msg) {
        return res.status(404).json({ message: "Message not found" });
      }

      if (msg.sender_id === userId) {
        return res.status(403).json({ message: "Cannot react to your own message" });
      }

      const participants = await storage.getMatchParticipants(msg.match_id);
      if (!participants || (participants.user1Id !== userId && participants.user2Id !== userId)) {
        return res.status(403).json({ message: "Not authorized to react to this message" });
      }

      const validReaction = reaction === "❤️" ? "❤️" : null;

      console.log(validReaction ? "MESSAGE_REACTION_ADDED" : "MESSAGE_REACTION_REMOVED", { messageId, userId, reaction: validReaction });

      const updated = await storage.reactToMessage(messageId, validReaction);
      res.json(updated);
    } catch (error: any) {
      console.error("MESSAGE_REACTION_ERROR", error?.message);
      res.status(500).json({ message: error?.message || "Failed to update reaction" });
    }
  });

  app.post("/api/matches/:matchId/messages", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;

      console.log("MSG_SEND", { matchId, userId, body: req.body });

      if (!matchId) {
        return res.status(400).json({ message: "Missing match_id in request" });
      }

      const parsed = messageBodySchema.safeParse(req.body);
      if (!parsed.success) {
        const fieldErrors = parsed.error.flatten().fieldErrors;
        console.log("MSG_VALIDATION_FAIL", fieldErrors);
        return res.status(400).json({ message: "Invalid message: content is required (1-500 chars)", errors: fieldErrors });
      }

      const { content } = parsed.data;

      if (containsContactInfo(content)) {
        return res.status(400).json({ message: "No exchange of information until a date has been agreed upon. Complete your calls and match your availability first!" });
      }

      const match = await storage.getMatch(matchId, userId);
      if (!match) {
        console.log("MSG_MATCH_NOT_FOUND", { matchId, userId });
        return res.status(404).json({ message: "Match not found" });
      }

      const callStage = match.callStage || 0;

      if (callStage === 0) {
        const messageCount = await storage.getUserMessageCount(matchId, userId);
        const [extension] = await db
          .select()
          .from(userBenefits)
          .where(and(
            eq(userBenefits.userId, userId),
            eq(userBenefits.type, "message_extension"),
            eq(userBenefits.activatedMatchId, matchId),
          ))
          .limit(1);
        const limit = extension ? 20 : 15;
        if (messageCount >= limit) {
          console.log("[CONNECTION_STAGE] POST_CALL_MESSAGE_LIMIT_REACHED", { matchId, userId, callStage: 0, count: messageCount, limit });
          return res.status(400).json({ message: "Message limit reached. Time to call!" });
        }
        if (messageCount === limit - 1) {
          console.log("[CONNECTION_STAGE] FIRST_CALL_UNLOCKED", { matchId, userId, messageCount });
        }
      } else if (callStage === 1) {
        const myPostCallCount = match.user1Id === userId ? (match.messageCount1 || 0) : (match.messageCount2 || 0);
        if (myPostCallCount >= 6) {
          console.log("[CONNECTION_STAGE] POST_CALL_MESSAGE_LIMIT_REACHED", { matchId, userId, callStage: 1, count: myPostCallCount, limit: 6 });
          return res.status(400).json({ message: "Post-call message limit reached. Your second call is ready!" });
        }
      } else {
        return res.status(400).json({ message: "Messaging is locked at this stage." });
      }

      const message = await storage.createMessage({
        matchId,
        senderId: userId,
        content: content.trim(),
      });

      await storage.incrementMessageCount(matchId, userId);

      if (callStage === 1) {
        const updatedMatch = await storage.getMatch(matchId, userId);
        if (updatedMatch) {
          const pc1 = updatedMatch.messageCount1 || 0;
          const pc2 = updatedMatch.messageCount2 || 0;
          const myNewCount = updatedMatch.user1Id === userId ? pc1 : pc2;
          console.log("[CONNECTION_STAGE] POST_CALL_MESSAGE_SENT", { matchId, userId, callStage, myPostCallCount: myNewCount });
          if (pc1 >= 6 && pc2 >= 6) {
            console.log("[CONNECTION_STAGE] SECOND_CALL_UNLOCKED", { matchId, pc1, pc2 });
            console.log("[CONNECTION_STAGE] CONNECTION_STAGE_CHANGED", { matchId, from: "post_call_messaging", to: "second_call_ready" });
          }
        }
      }

      const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;
      if (otherUserId.startsWith("seed-")) {
        const otherProfile = await storage.getProfile(otherUserId);
        const replyStorage = storage;
        if (callStage === 0) {
          const otherCount = await storage.getUserMessageCount(matchId, otherUserId);
          if (otherCount < 15) {
            setTimeout(async () => {
              try {
                const reply = generateAutoReply(otherProfile, otherCount);
                await replyStorage.createMessage({ matchId, senderId: otherUserId, content: reply });
                await replyStorage.incrementMessageCount(matchId, otherUserId);
              } catch (err) {
                console.error("Auto-reply error:", err);
              }
            }, 1500 + Math.random() * 2000);
          }
        } else if (callStage === 1) {
          const freshMatch = await storage.getMatch(matchId, otherUserId);
          if (freshMatch) {
            const otherPostCallCount = freshMatch.user1Id === otherUserId ? (freshMatch.messageCount1 || 0) : (freshMatch.messageCount2 || 0);
            if (otherPostCallCount < 6) {
              setTimeout(async () => {
                try {
                  const reply = generateAutoReply(otherProfile, 30 + otherPostCallCount);
                  await replyStorage.createMessage({ matchId, senderId: otherUserId, content: reply });
                  await replyStorage.incrementMessageCount(matchId, otherUserId);
                } catch (err) {
                  console.error("Auto-reply (post-call) error:", err);
                }
              }, 1500 + Math.random() * 2000);
            }
          }
        }
      }

      res.json(message);
    } catch (error) {
      console.error("Error sending message:", error);
      res.status(500).json({ message: "Failed to send message" });
    }
  });

  app.post("/api/matches/:matchId/call/start", isAuthenticated, async (req: any, res) => {
    try {
      const serverStorage = getCallStorage(req);
      const userId = req.user.id;
      const matchId = req.params.matchId;
      console.log("[CALL_START] CALL_REQUEST_STARTED", { path: "/api/matches/:matchId/call/start", matchId, userId, timestamp: new Date().toISOString() });
      console.log("[CALL_START] CALL_SESSION_CHECKED", { path: "/api/matches/:matchId/call/start", matchId, userId, timestamp: new Date().toISOString() });
      const result = await serverStorage.startCall(matchId, userId);
      if (!result) {
        console.log("[CALL_START] CALL_API_RESPONSE", { status: 404, matchId, userId });
        return res.status(404).json({ message: "Match not found or call not allowed" });
      }

      const { match, status } = result;

      if (status === "blocked") {
        console.log("[CALL_START] DUPLICATE_CALL_BLOCKED", { matchId, existingCaller: match.callInitiatorId, blockedUser: userId, callSessionId: match.callSessionId });
        return res.status(409).json({ message: "A call is already in progress", match });
      }

      if (status === "reused") {
        console.log("[CALL_START] CALL_SESSION_REUSED", { matchId, callSessionId: match.callSessionId, callerId: userId });
        return res.json(match);
      }

      const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;
      const callerProfile = await serverStorage.getProfile(userId);
      const callerName = callerProfile?.firstName || "Someone";
      console.log("[CALL_START] CALL_SESSION_CREATED", { matchId, callSessionId: match.callSessionId, SESSION_PARTICIPANTS_COUNT: 2 });
      console.log("[CALL_START] CALLER_ASSIGNED", { matchId, callerId: userId, callerName });
      console.log("[CALL_START] RECEIVER_ASSIGNED", { matchId, receiverId: otherUserId });
      if ((match.callStage || 0) === 0) {
        console.log("[CONNECTION_STAGE] FIRST_CALL_STARTED", { matchId, callSessionId: match.callSessionId, userId, callStage: match.callStage || 0 });
        console.log("[CONNECTION_STAGE] CONNECTION_STAGE_CHANGED", { matchId, from: "chat", to: "first_call" });
      } else if ((match.callStage || 0) === 1) {
        console.log("[CONNECTION_STAGE] SECOND_CALL_STARTED", { matchId, callSessionId: match.callSessionId, userId, callStage: match.callStage || 0 });
        console.log("[CONNECTION_STAGE] CONNECTION_STAGE_CHANGED", { matchId, from: "post_call_messaging", to: "second_call" });
      }

      broadcastCallEvent(matchId, {
        type: "call:ring",
        matchId,
        callerId: userId,
        callerName,
        callSessionId: match.callSessionId,
      });

      if (otherUserId.startsWith("seed-")) {
        setTimeout(async () => {
          try {
            await serverStorage.answerCall(matchId, otherUserId);
            console.log("[CALL_AUTO_ANSWER] CALL_SESSION_JOINED", { matchId, callSessionId: match.callSessionId, userId: otherUserId });
            broadcastCallEvent(matchId, {
              type: "call:answered",
              matchId,
              userId: otherUserId,
              callSessionId: match.callSessionId,
            });
          } catch (err) {
            console.error("[CALL_AUTO_ANSWER] Error:", err);
          }
        }, 3000 + Math.random() * 2000);
      }

      res.json(match);
    } catch (error: any) {
      const matchId = req.params.matchId;
      const userId = req.user?.id;
      console.error("[CALL_START] CALL_ROUTE_ERROR", {
        CALL_ROUTE_NAME: "POST /api/matches/:matchId/call/start",
        CALL_ROUTE_ERROR: error?.message,
        stack: error?.stack,
        requestPayload: req.body,
        matchId,
        userId,
        callSessionId: null,
      });
      res.status(500).json({
        message: error?.message || "Failed to start call",
        route: "POST /api/matches/:matchId/call/start",
        detail: error?.stack?.split("\n")[0] || null,
      });
    }
  });

  app.post("/api/matches/:matchId/call/answer", isAuthenticated, async (req: any, res) => {
    try {
      const serverStorage = getCallStorage(req);
      const userId = req.user.id;
      const matchId = req.params.matchId;
      console.log("[CALL_ANSWER] CALL_API_REQUEST", { path: "/api/matches/:matchId/call/answer", matchId, userId, timestamp: new Date().toISOString() });
      const match = await serverStorage.answerCall(matchId, userId);
      if (!match) {
        console.log("[CALL_ANSWER] CALL_API_RESPONSE", { status: 404, matchId, userId });
        return res.status(404).json({ message: "Match not found or you cannot answer your own call" });
      }
      console.log("[CALL_ANSWER] CALL_API_RESPONSE", { status: 200, matchId, CALL_SESSION_ID: match.callSessionId, userId });
      broadcastCallEvent(matchId, {
        type: "call:answered",
        matchId,
        userId,
        callSessionId: match.callSessionId,
      });
      res.json(match);
    } catch (error: any) {
      const matchId = req.params.matchId;
      const userId = req.user?.id;
      console.error("[CALL_ANSWER] CALL_ROUTE_ERROR", {
        CALL_ROUTE_NAME: "POST /api/matches/:matchId/call/answer",
        CALL_ROUTE_ERROR: error?.message,
        stack: error?.stack,
        requestPayload: req.body,
        matchId,
        userId,
        callSessionId: null,
      });
      res.status(500).json({
        message: error?.message || "Failed to answer call",
        route: "POST /api/matches/:matchId/call/answer",
        detail: error?.stack?.split("\n")[0] || null,
      });
    }
  });

  app.post("/api/matches/:matchId/call/cancel", isAuthenticated, async (req: any, res) => {
    const userId = req.user.id;
    const matchId = req.params.matchId;
    try {
      const serverStorage = getCallStorage(req);
      const match = await serverStorage.cancelCall(matchId, userId);
      if (!match) {
        return res.status(404).json({ message: "Match not found" });
      }
      broadcastCallEvent(matchId, {
        type: "call:cancelled",
        matchId,
        userId,
      });
      res.json(match);
    } catch (error: any) {
      console.error("[CALL_CANCEL] CALL_ROUTE_ERROR", {
        CALL_ROUTE_NAME: "POST /api/matches/:matchId/call/cancel",
        CALL_ROUTE_ERROR: error?.message,
        stack: error?.stack,
        requestPayload: req.body,
        matchId,
        userId,
        callSessionId: null,
      });

      broadcastCallEvent(matchId, {
        type: "call:cancelled",
        matchId,
        userId,
      });

      try {
        const auth = req.headers.authorization;
        const readClient = auth ? createUserClient(auth) : supabase;
        const { data: matchRow } = await readClient
          .from("matches")
          .select("*")
          .eq("id", matchId)
          .maybeSingle();
        if (matchRow) {
          const mapped = mapMatch(matchRow);
          mapped.callStartedAt = null;
          mapped.callInitiatorId = null;
          mapped.callAnswered = false;
          mapped.callCompleted = false;
          return res.json(mapped);
        }
      } catch (readErr) {
        console.error("[CALL_CANCEL] FALLBACK_READ_FAILED", { matchId, userId, error: (readErr as any)?.message });
      }

      res.status(500).json({
        message: error?.message || "Failed to cancel call",
        route: "POST /api/matches/:matchId/call/cancel",
        detail: error?.stack?.split("\n")[0] || null,
      });
    }
  });

  app.post("/api/matches/:matchId/call/complete", isAuthenticated, async (req: any, res) => {
    try {
      const serverStorage = getCallStorage(req);
      const userId = req.user.id;
      const matchId = req.params.matchId;
      const match = await serverStorage.completeCall(matchId, userId);
      if (!match) {
        return res.status(404).json({ message: "Match not found" });
      }
      broadcastCallEvent(matchId, {
        type: "call:ended",
        matchId,
        userId,
      });
      res.json(match);
    } catch (error: any) {
      const matchId = req.params.matchId;
      const userId = req.user?.id;
      console.error("[CALL_COMPLETE] CALL_ROUTE_ERROR", {
        CALL_ROUTE_NAME: "POST /api/matches/:matchId/call/complete",
        CALL_ROUTE_ERROR: error?.message,
        stack: error?.stack,
        requestPayload: req.body,
        matchId,
        userId,
        callSessionId: null,
      });
      res.status(500).json({
        message: error?.message || "Failed to complete call",
        route: "POST /api/matches/:matchId/call/complete",
        detail: error?.stack?.split("\n")[0] || null,
      });
    }
  });

  app.post("/api/matches/:matchId/face-call/accept", isAuthenticated, async (req: any, res) => {
    try {
      const serverStorage = getCallStorage(req);
      const userId = req.user.id;
      const matchId = req.params.matchId;
      console.log("[FACE_CALL_ACCEPT] CALL_API_REQUEST", { path: "/api/matches/:matchId/face-call/accept", matchId, userId });
      const match = await serverStorage.acceptFaceCall(matchId, userId);
      if (!match) {
        console.log("[FACE_CALL_ACCEPT] CALL_API_RESPONSE", { status: 404, matchId, userId });
        return res.status(404).json({ message: "Match not found or not eligible for face call" });
      }

      const isDev = process.env.NODE_ENV === "development";
      const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;
      if (isDev || otherUserId.startsWith("seed-")) {
        setTimeout(async () => {
          try {
            await serverStorage.acceptFaceCall(matchId, otherUserId);
            console.log("AUTO_ACCEPT_FACE_CALL", matchId, otherUserId);
          } catch (err) {
            console.error("Auto face-call accept error:", err);
          }
        }, 1500 + Math.random() * 2000);
      }

      console.log("[FACE_CALL_ACCEPT] CALL_API_RESPONSE", { status: 200, matchId, userId });
      res.json(match);
    } catch (error: any) {
      const matchId = req.params.matchId;
      const userId = req.user?.id;
      console.error("[FACE_CALL_ACCEPT] CALL_ROUTE_ERROR", {
        CALL_ROUTE_NAME: "POST /api/matches/:matchId/face-call/accept",
        CALL_ROUTE_ERROR: error?.message,
        stack: error?.stack,
        requestPayload: req.body,
        matchId,
        userId,
        callSessionId: null,
      });
      res.status(500).json({
        message: error?.message || "Failed to accept face call",
        route: "POST /api/matches/:matchId/face-call/accept",
        detail: error?.stack?.split("\n")[0] || null,
      });
    }
  });

  app.post("/api/matches/:matchId/face-call/decline", isAuthenticated, async (req: any, res) => {
    try {
      const serverStorage = getCallStorage(req);
      const userId = req.user.id;
      console.log("[FACE_CALL_DECLINE] CALL_API_REQUEST", { path: "/api/matches/:matchId/face-call/decline", matchId: req.params.matchId, userId });
      const match = await serverStorage.declineFaceCall(req.params.matchId, userId);
      if (!match) {
        console.log("[FACE_CALL_DECLINE] CALL_API_RESPONSE", { status: 404, matchId: req.params.matchId, userId });
        return res.status(404).json({ message: "Match not found" });
      }
      console.log("[FACE_CALL_DECLINE] CALL_API_RESPONSE", { status: 200, matchId: req.params.matchId, userId });
      res.json(match);
    } catch (error: any) {
      const matchId = req.params.matchId;
      const userId = req.user?.id;
      console.error("[FACE_CALL_DECLINE] CALL_ROUTE_ERROR", {
        CALL_ROUTE_NAME: "POST /api/matches/:matchId/face-call/decline",
        CALL_ROUTE_ERROR: error?.message,
        stack: error?.stack,
        requestPayload: req.body,
        matchId,
        userId,
        callSessionId: null,
      });
      res.status(500).json({
        message: error?.message || "Failed to decline face call",
        route: "POST /api/matches/:matchId/face-call/decline",
        detail: error?.stack?.split("\n")[0] || null,
      });
    }
  });

  app.get("/api/popular", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const myProfile = await storage.getProfile(userId);
      const preference = myProfile?.datingPreference;
      const popular = await storage.getPopularProfiles(30, preference, myProfile?.gender);

      const selfFiltered = popular.filter(p => p.userId !== userId);

      const shuffled = selfFiltered.sort(() => Math.random() - 0.5);
      const result = shuffled.slice(0, 10);
      res.json(result);
    } catch (error) {
      console.error("Error fetching popular profiles:", error);
      res.status(500).json({ message: "Failed to fetch popular profiles" });
    }
  });

  app.get("/api/spin-status", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;

      // Run all spin-status checks in parallel
      const [spinsThisWeek, dailyLikes, consecutiveDays, hasUnusedStreak] = await Promise.all([
        storage.getSpinsThisWeek(userId),
        storage.getDailyLikeCount(userId),
        storage.getConsecutiveLikeDays(userId, 10),
        storage.hasUnusedStreakSpin(userId),
      ]);

      const streakComplete = consecutiveDays >= 3;
      const canSpin = (streakComplete && hasUnusedStreak) || (!streakComplete && spinsThisWeek === 0);

      res.json({ spinsThisWeek, dailyLikes, consecutiveDays, streakComplete, canSpin });
    } catch (error) {
      console.error("Error fetching spin status:", error);
      res.status(500).json({ message: "Failed to fetch spin status" });
    }
  });

  app.post("/api/spin", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { standoutUserId } = req.body;

      const spinsThisWeek = await storage.getSpinsThisWeek(userId);
      const consecutiveDays = await storage.getConsecutiveLikeDays(userId, 10);
      const streakComplete = consecutiveDays >= 3;
      const hasUnusedStreak = await storage.hasUnusedStreakSpin(userId);

      let canSpin = false;
      if (streakComplete && hasUnusedStreak) {
        canSpin = true;
      } else if (!streakComplete && spinsThisWeek === 0) {
        canSpin = true;
      }

      if (!canSpin) {
        return res.status(403).json({ message: "No spins available" });
      }

      await storage.recordSpin(userId);

      if (standoutUserId) {
        await storage.addSpinStandout(userId, standoutUserId);
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error recording spin:", error);
      res.status(500).json({ message: "Failed to record spin" });
    }
  });

  app.post("/api/spin-requests", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { toUserId, message } = req.body;

      if (!toUserId || !message?.trim()) {
        return res.status(400).json({ message: "Recipient and message are required" });
      }

      if (message.length > 500) {
        return res.status(400).json({ message: "Message too long (500 char max)" });
      }

      const request = await storage.createSpinRequest(userId, toUserId, message.trim());
      res.json(request);
    } catch (error) {
      console.error("Error creating spin request:", error);
      res.status(500).json({ message: "Failed to send spin request" });
    }
  });

  app.get("/api/spin-requests", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const incoming = await storage.getIncomingSpinRequests(userId);
      const outgoing = await storage.getOutgoingSpinRequests(userId);
      res.json({ incoming, outgoing });
    } catch (error) {
      console.error("Error fetching spin requests:", error);
      res.status(500).json({ message: "Failed to fetch spin requests" });
    }
  });

  app.post("/api/spin-requests/:id/respond", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { id } = req.params;
      const { accept } = req.body;

      if (typeof accept !== "boolean") {
        return res.status(400).json({ message: "accept must be true or false" });
      }

      const updated = await storage.respondToSpinRequest(id, userId, accept);
      if (!updated) {
        return res.status(404).json({ message: "Request not found or already handled" });
      }

      let matchCreated = false;
      if (accept) {
        const matchCount = await storage.getMatchCount(userId);
        if (matchCount >= 8) {
          return res.status(400).json({ message: "Connections room is full. Close a connection to free up space." });
        }

        const existingMatches = await storage.getMatchesForUser(userId);
        const alreadyMatched = existingMatches.some(
          m => m.user1Id === updated.fromUserId || m.user2Id === updated.fromUserId
        );

        if (!alreadyMatched) {
          const match = await storage.createMatch(updated.fromUserId, updated.toUserId);

          await storage.createMessage({
            matchId: match.id,
            senderId: updated.fromUserId,
            content: updated.message,
          });
          await storage.incrementMessageCount(match.id, updated.fromUserId);

          matchCreated = true;
        }
      }

      res.json({ ...updated, matchCreated });
    } catch (error) {
      console.error("Error responding to spin request:", error);
      res.status(500).json({ message: "Failed to respond to spin request" });
    }
  });

  app.delete("/api/matches/:matchId", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;
      const removed = await storage.removeMatch(matchId, userId);
      if (!removed) {
        return res.status(404).json({ message: "Match not found" });
      }
      res.json({ success: true });
    } catch (error) {
      console.error("Error removing match:", error);
      res.status(500).json({ message: "Failed to remove connection" });
    }
  });

  app.get("/api/match-count", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const count = await storage.getMatchCount(userId);
      res.json({ count });
    } catch (error) {
      console.error("Error fetching match count:", error);
      res.status(500).json({ message: "Failed to fetch match count" });
    }
  });

  app.get("/api/who-liked-you", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const incomingOpens = await storage.getIncomingOpens(userId);
      res.json(incomingOpens);
    } catch (error) {
      console.error("Error fetching who liked you:", error);
      res.status(500).json({ message: "Failed to fetch likes" });
    }
  });

  app.post("/api/matches/:matchId/schedule-call", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;
      const { action, proposedTime } = req.body;

      if (!["propose", "accept", "decline", "reschedule"].includes(action)) {
        return res.status(400).json({ message: "Invalid action" });
      }

      const match = await storage.getMatch(matchId, userId);
      if (!match) return res.status(404).json({ message: "Match not found" });

      const callStage = match.callStage || 0;
      if (callStage >= 2) {
        return res.status(400).json({ message: "No more calls to schedule at this stage" });
      }

      const SCHEDULE_PREFIX = "__SCHEDULE__:";
      const stageMsgs = match.messages
        .filter(m => m.content.startsWith(SCHEDULE_PREFIX))
        .filter(m => {
          try { return JSON.parse(m.content.slice(SCHEDULE_PREFIX.length)).stage === callStage; }
          catch { return false; }
        });
      const lastData: any = stageMsgs.length > 0
        ? (() => { try { return JSON.parse(stageMsgs[stageMsgs.length - 1].content.slice(SCHEDULE_PREFIX.length)); } catch { return null; } })()
        : null;

      if ((action === "accept" || action === "decline")) {
        if (!lastData || !["propose", "reschedule"].includes(lastData.type)) {
          return res.status(400).json({ message: "No pending proposal to respond to" });
        }
        if (lastData.proposedBy === userId) {
          return res.status(400).json({ message: "Cannot respond to your own proposal" });
        }
      }

      if ((action === "propose" || action === "reschedule") && !proposedTime) {
        return res.status(400).json({ message: "proposedTime is required" });
      }

      if (action === "propose" && lastData?.type === "accept") {
        return res.status(400).json({ message: "Call is already confirmed. Use reschedule if needed." });
      }

      const resolvedTime = (action === "accept" || action === "decline")
        ? (lastData?.proposedTime ?? new Date().toISOString())
        : proposedTime;

      const scheduleData = { type: action, proposedBy: userId, proposedTime: resolvedTime, stage: callStage };
      const content = `${SCHEDULE_PREFIX}${JSON.stringify(scheduleData)}`;

      const message = await storage.createMessage({ matchId, senderId: userId, content });

      const logLabels: Record<string, string> = {
        propose: "CALL_TIME_PROPOSED",
        accept: "CALL_TIME_ACCEPTED",
        decline: "CALL_TIME_DECLINED",
        reschedule: "CALL_TIME_RESCHEDULED",
      };
      console.log(`[CALL_SCHEDULE] ${logLabels[action]}`, { matchId, userId, action, proposedTime: resolvedTime, callStage });
      if (action === "accept") {
        console.log("[CALL_SCHEDULE] CALL_SCHEDULE_CONFIRMED", { matchId, callStage, scheduledTime: resolvedTime });
      }

      const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;
      if (["propose", "reschedule"].includes(action) && otherUserId.startsWith("seed-")) {
        const replyStorage = storage;
        setTimeout(async () => {
          try {
            const acceptData = { type: "accept", proposedBy: otherUserId, proposedTime: resolvedTime, stage: callStage };
            await replyStorage.createMessage({ matchId, senderId: otherUserId, content: `${SCHEDULE_PREFIX}${JSON.stringify(acceptData)}` });
            console.log("[CALL_SCHEDULE] SEED_AUTO_ACCEPTED", { matchId, otherUserId, callStage, scheduledTime: resolvedTime });
          } catch (err) { console.error("Seed auto-accept error:", err); }
        }, 1500 + Math.random() * 1500);
      }

      res.json({ message, scheduleData });
    } catch (error) {
      console.error("Error scheduling call:", error);
      res.status(500).json({ message: "Failed to schedule call" });
    }
  });

  app.post("/api/matches/:matchId/meet-availability", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;
      const { slots } = req.body;

      if (!Array.isArray(slots) || slots.length === 0 || slots.length > 5) {
        return res.status(400).json({ message: "Please select 1-5 time slots" });
      }

      const availability = JSON.stringify(slots);
      const match = await storage.setMeetAvailability(matchId, userId, availability);
      if (!match) {
        return res.status(404).json({ message: "Match not found or calls not completed yet" });
      }

      res.json(match);
    } catch (error) {
      console.error("Error setting meet availability:", error);
      res.status(500).json({ message: "Failed to set availability" });
    }
  });

  app.post("/api/matches/:matchId/exchange-number", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const { matchId } = req.params;

      const profile = await storage.getProfile(userId);
      if (!profile?.phoneNumber) {
        return res.status(400).json({ message: "Please add your phone number first" });
      }

      const match = await storage.exchangeNumber(matchId, userId);
      if (!match) {
        return res.status(404).json({ message: "Match not found, calls not completed, or no matching dates yet" });
      }

      await storage.createMessage({
        matchId,
        senderId: userId,
        content: `My number is ${profile.phoneNumber}`,
      });

      res.json(match);
    } catch (error) {
      console.error("Error exchanging number:", error);
      res.status(500).json({ message: "Failed to exchange number" });
    }
  });

  app.post("/api/dev/reset-test-data", isAuthenticated, async (req: any, res) => {
    try {
      if (process.env.NODE_ENV !== "development") {
        return res.status(403).json({ message: "Not available in production" });
      }
      const storage = getStorage(req);
      const userId = req.user.id;
      await storage.resetUserTestData(userId);
      res.json({ ok: true });
    } catch (error) {
      console.error("Error resetting test data:", error);
      res.status(500).json({ message: "Failed to reset test data" });
    }
  });

  // --- Benefits ---

  app.get("/api/benefits", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const rows = await db.select().from(userBenefits).where(eq(userBenefits.userId, userId));
      const available: Record<string, number> = {};
      const activated: Record<string, Record<string, number>> = {};
      for (const b of rows) {
        if (!b.activatedMatchId) {
          available[b.type] = (available[b.type] || 0) + 1;
        } else {
          if (!activated[b.activatedMatchId]) activated[b.activatedMatchId] = {};
          activated[b.activatedMatchId][b.type] = (activated[b.activatedMatchId][b.type] || 0) + 1;
        }
      }
      res.json({ available, activated });
    } catch (error) {
      console.error("Error fetching benefits:", error);
      res.status(500).json({ message: "Failed to fetch benefits" });
    }
  });

  app.post("/api/benefits/activate", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { type, matchId } = req.body;
      if (!type || !matchId) {
        return res.status(400).json({ message: "type and matchId are required" });
      }
      const [benefit] = await db
        .select()
        .from(userBenefits)
        .where(and(
          eq(userBenefits.userId, userId),
          eq(userBenefits.type, type),
          isNull(userBenefits.activatedMatchId),
        ))
        .limit(1);
      if (!benefit) {
        return res.status(404).json({ message: "No available benefit of this type" });
      }
      const [updated] = await db
        .update(userBenefits)
        .set({ activatedMatchId: matchId })
        .where(eq(userBenefits.id, benefit.id))
        .returning();
      res.json({ success: true, benefit: updated });
    } catch (error) {
      console.error("Error activating benefit:", error);
      res.status(500).json({ message: "Failed to activate benefit" });
    }
  });

  app.post("/api/benefits/grant", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { type, quantity = 1 } = req.body;
      if (!type) {
        return res.status(400).json({ message: "type is required" });
      }
      const rows = Array.from({ length: Number(quantity) }, () => ({ userId, type: String(type) }));
      const granted = await db.insert(userBenefits).values(rows).returning();
      res.json({ granted });
    } catch (error) {
      console.error("Error granting benefit:", error);
      res.status(500).json({ message: "Failed to grant benefit" });
    }
  });

  // ── Stripe publishable key (client needs this for Stripe.js) ─────────────

  app.get("/api/stripe/config", isAuthenticated, async (_req, res) => {
    try {
      const publishableKey = await getStripePublishableKey();
      res.json({ publishableKey });
    } catch (err: any) {
      console.error("Error fetching Stripe config:", err.message);
      res.status(500).json({ message: "Stripe not configured" });
    }
  });

  // ── Create Stripe Checkout session for Elevate purchase ───────────────────
  // Called when user taps "Pay $X" in the checkout step.
  // Returns a Stripe-hosted checkout URL; on success Stripe redirects to
  // /elevate/success?session_id=XXX which the client polls to activate.

  // ── Pricing table (shared between checkout and metadata) ─────────────────
  const ELEVATE_PACKS = {
    "elevate-1":     { type: "elevate" as const, quantity: 1, unitAmount: 999,  label: "1 Elevate (30 min)" },
    "elevate-3":     { type: "elevate" as const, quantity: 3, unitAmount: 2699, label: "3 Elevates (30 min each)" },
    "elevate-5":     { type: "elevate" as const, quantity: 5, unitAmount: 3999, label: "5 Elevates (30 min each)" },
    "super-elevate": { type: "super_elevate" as const, quantity: 1, unitAmount: 3499, label: "Super Elevate (60 min)" },
  };

  app.post("/api/stripe/elevate-checkout", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { packId } = req.body;
      const pack = ELEVATE_PACKS[packId as keyof typeof ELEVATE_PACKS];
      if (!pack) {
        return res.status(400).json({ message: "Invalid pack ID. Must be one of: elevate-1, elevate-3, elevate-5, super-elevate" });
      }

      const stripe = await getUncachableStripeClient();
      const domains = process.env.REPLIT_DOMAINS?.split(",")[0] ?? "localhost:5000";
      const baseUrl = `https://${domains}`;

      const isSuper = pack.type === "super_elevate";
      const description = isSuper
        ? "8× visibility boost in Discovery and the Intention Wheel for 60 minutes"
        : `3× visibility boost per use • ${pack.quantity} boost${pack.quantity > 1 ? "s" : ""} • 30 minutes each`;

      const session = await stripe.checkout.sessions.create({
        payment_method_types: ["card"],
        line_items: [
          {
            price_data: {
              currency: "usd",
              unit_amount: pack.unitAmount,
              product_data: { name: pack.label, description },
            },
            quantity: 1,
          },
        ],
        mode: "payment",
        success_url: `${baseUrl}/elevate/success?session_id={CHECKOUT_SESSION_ID}&pack=${packId}`,
        cancel_url: `${baseUrl}/likes`,
        metadata: { userId, packId, elevateType: pack.type, quantity: String(pack.quantity) },
      });

      res.json({ url: session.url, sessionId: session.id });
    } catch (err: any) {
      console.error("Error creating Stripe checkout:", err.message);
      res.status(500).json({ message: "Failed to create checkout session" });
    }
  });

  // ── Verify Stripe session & add credits ───────────────────────────────────
  // Called by /elevate/success after redirect. Awards credits, does NOT activate yet.

  app.post("/api/stripe/elevate-activate", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { sessionId } = req.body;
      if (!sessionId) return res.status(400).json({ message: "sessionId required" });

      const stripe = await getUncachableStripeClient();
      const session = await stripe.checkout.sessions.retrieve(sessionId);

      if (session.payment_status !== "paid") {
        return res.status(402).json({ message: "Payment not completed", paymentStatus: session.payment_status });
      }
      if (session.metadata?.userId !== userId) {
        return res.status(403).json({ message: "Session user mismatch" });
      }

      const packId = session.metadata?.packId ?? "elevate-1";
      const pack = ELEVATE_PACKS[packId as keyof typeof ELEVATE_PACKS];
      if (!pack) return res.status(400).json({ message: "Unknown pack" });

      // Award all credits from the pack
      await getStorage(req).addElevateCredits(userId, pack.type, pack.quantity);

      // Auto-activate one boost immediately so user sees it live right away
      const activateResult = await getStorage(req).activateElevate(userId, pack.type);
      const durationMinutes = pack.type === "super_elevate" ? 60 : 30;
      const expiresAt = activateResult.success
        ? new Date(Date.now() + durationMinutes * 60 * 1000).toISOString()
        : null;

      res.json({
        success: true,
        packId,
        elevateType: pack.type,
        quantity: pack.quantity,
        creditsAdded: pack.quantity,
        // boost immediately live
        boostActive: activateResult.success,
        expiresAt,
        durationMinutes,
      });
    } catch (err: any) {
      console.error("Error processing elevate payment:", err.message);
      res.status(500).json({ message: "Failed to process payment" });
    }
  });

  // ── Use a credit to activate a boost now ─────────────────────────────────

  app.post("/api/elevate/activate", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const { type } = req.body;
      if (type !== "elevate" && type !== "super_elevate") {
        return res.status(400).json({ message: "type must be 'elevate' or 'super_elevate'" });
      }
      const result = await getStorage(req).activateElevate(userId, type);
      if (!result.success) {
        return res.status(402).json({ message: result.error ?? "No credits available" });
      }
      const durationMinutes = type === "super_elevate" ? 60 : 30;
      res.json({ success: true, elevateType: type, durationMinutes });
    } catch (err: any) {
      console.error("Error activating elevate:", err.message);
      res.status(500).json({ message: "Failed to activate boost" });
    }
  });

  // ── Elevate status & session-stats ────────────────────────────────────────

  app.get("/api/elevate/status", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const status = await getStorage(req).getElevateStatus(userId);
      res.json(status);
    } catch (error) {
      console.error("Error fetching elevate status:", error);
      res.status(500).json({ message: "Failed to fetch elevate status" });
    }
  });

  app.get("/api/elevate/session-stats", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.id;
      const stats = await getStorage(req).getElevateSessionStats(userId);
      res.json({
        ...stats,
        expiresAt: stats.expiresAt?.toISOString() ?? null,
        startedAt: stats.startedAt?.toISOString() ?? null,
      });
    } catch (error) {
      console.error("Error fetching elevate session stats:", error);
      res.status(500).json({ message: "Failed to fetch session stats" });
    }
  });

  await seedDatabase();

  return httpServer;
}
