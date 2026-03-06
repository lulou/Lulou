import type { Express, RequestHandler } from "express";
import { createServer, type Server } from "http";
import { SupabaseStorage } from "./storage";
import { seedDatabase } from "./seed";
import { z } from "zod";
import type { Profile } from "@shared/schema";
import { supabase, createUserClient } from "./supabase";

const serverBroadcastChannels = new Map<string, ReturnType<typeof supabase.channel>>();
const serverChannelTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

const isAuthenticated: RequestHandler = async (req: any, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];
  const { data: { user }, error } = await supabase.auth.getUser(token);

  if (error || !user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  req.user = user;
  next();
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
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const email = req.user.email || "";
      await storage.createProfile({
        userId,
        email,
        firstName: "",
        age: 0,
        gender: "",
        datingPreference: "",
        location: "",
        photos: [],
        signals: [],
        datingIntent: "",
        greenFlags: [],
        connectionStyle: "",
        conversationStarters: [],
        questions: [],
        onboardingComplete: false,
      });
      console.log("AUTH_INIT: Upserted profile for", userId);
      res.json({ ok: true });
    } catch (error: any) {
      console.error("AUTH_INIT_ERROR", error?.message, error);
      res.status(500).json({ message: error?.message || "Failed to init profile" });
    }
  });

  app.get("/api/profile", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const userId = req.user.id;
      const profile = await storage.getProfile(userId);
      if (!profile) {
        return res.status(404).json({ message: "Profile not found" });
      }
      res.json(profile);
    } catch (error) {
      console.error("Error fetching profile:", error);
      res.status(500).json({ message: "Failed to fetch profile" });
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
        return res.json([]);
      }
      const discovered = await storage.getDiscoverProfiles(userId, myProfile.gender, myProfile.datingPreference, myProfile.preferredAgeMin || 18, myProfile.preferredAgeMax || 45);
      res.json(discovered);
    } catch (error) {
      console.error("Error discovering profiles:", error);
      res.status(500).json({ message: "Failed to discover profiles" });
    }
  });

  app.post("/api/interactions", isAuthenticated, async (req: any, res) => {
    try {
      const storage = getStorage(req);
      const fromUserId = req.user.id;
      const parsed = interactionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid interaction data" });
      }

      const { toUserId, type } = parsed.data;

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
    } catch (error) {
      console.error("Error creating interaction:", error);
      res.status(500).json({ message: "Failed to create interaction" });
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

      const messageCount = await storage.getUserMessageCount(matchId, userId);
      if (messageCount >= 15) {
        return res.status(400).json({ message: "Message limit reached. Time to call!" });
      }

      const message = await storage.createMessage({
        matchId,
        senderId: userId,
        content: content.trim(),
      });

      await storage.incrementMessageCount(matchId, userId);

      const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;
      if (otherUserId.startsWith("seed-")) {
        const otherProfile = await storage.getProfile(otherUserId);
        const otherCount = await storage.getUserMessageCount(matchId, otherUserId);
        if (otherCount < 15) {
          const replyStorage = storage;
          setTimeout(async () => {
            try {
              const reply = generateAutoReply(otherProfile, otherCount);
              await replyStorage.createMessage({
                matchId,
                senderId: otherUserId,
                content: reply,
              });
              await replyStorage.incrementMessageCount(matchId, otherUserId);
            } catch (err) {
              console.error("Auto-reply error:", err);
            }
          }, 1500 + Math.random() * 2000);
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
      const serverStorage = new SupabaseStorage();
      const userId = req.user.id;
      const matchId = req.params.matchId;
      console.log("[CALL_START] CALL_API_REQUEST", { path: "/api/matches/:matchId/call/start", matchId, userId, timestamp: new Date().toISOString() });
      const match = await serverStorage.startCall(matchId, userId);
      if (!match) {
        console.log("[CALL_START] CALL_API_RESPONSE", { status: 404, matchId, userId });
        return res.status(404).json({ message: "Match not found" });
      }

      const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;
      const callerProfile = await serverStorage.getProfile(userId);
      const callerName = callerProfile?.firstName || "Someone";
      console.log("[CALL_START] CALL_API_RESPONSE", { status: 200, matchId, CALL_SESSION_ID: match.callSessionId, callerId: userId, receiverId: otherUserId, callerName });

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
    } catch (error) {
      console.error("[CALL_START] Error:", error);
      res.status(500).json({ message: "Failed to start call" });
    }
  });

  app.post("/api/matches/:matchId/call/answer", isAuthenticated, async (req: any, res) => {
    try {
      const serverStorage = new SupabaseStorage();
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
    } catch (error) {
      console.error("[CALL_ANSWER] Error:", error);
      res.status(500).json({ message: "Failed to answer call" });
    }
  });

  app.post("/api/matches/:matchId/call/cancel", isAuthenticated, async (req: any, res) => {
    try {
      const serverStorage = new SupabaseStorage();
      const userId = req.user.id;
      const matchId = req.params.matchId;
      const preCancelMatch = await serverStorage.getMatch(matchId, userId);
      const prevSessionId = preCancelMatch?.callSessionId || null;
      console.log("[CALL_CANCEL] CALL_API_REQUEST", { path: "/api/matches/:matchId/call/cancel", matchId, userId, CALL_SESSION_ID: prevSessionId, timestamp: new Date().toISOString() });
      const match = await serverStorage.cancelCall(matchId, userId);
      if (!match) {
        console.log("[CALL_CANCEL] CALL_API_RESPONSE", { status: 404, matchId, userId });
        return res.status(404).json({ message: "Match not found" });
      }
      console.log("[CALL_CANCEL] CANCEL_CALL_SESSION_UPDATED", { status: 200, matchId, CALL_SESSION_ID: prevSessionId, userId });
      broadcastCallEvent(matchId, {
        type: "call:ended",
        matchId,
        userId,
      });
      broadcastCallEvent(matchId, {
        type: "call:cancelled",
        matchId,
        userId,
        callSessionId: prevSessionId,
      });
      console.log("[CALL_CANCEL] CANCEL_CALL_EVENT_SENT", { matchId, CALL_SESSION_ID: prevSessionId, userId });
      res.json(match);
    } catch (error) {
      console.error("[CALL_CANCEL] Error:", error);
      res.status(500).json({ message: "Failed to cancel call" });
    }
  });

  app.post("/api/matches/:matchId/call/complete", isAuthenticated, async (req: any, res) => {
    try {
      const serverStorage = new SupabaseStorage();
      const userId = req.user.id;
      const matchId = req.params.matchId;
      const preCompleteMatch = await serverStorage.getMatch(matchId, userId);
      const prevSessionId = preCompleteMatch?.callSessionId || null;
      console.log("[CALL_COMPLETE] CALL_API_REQUEST", { path: "/api/matches/:matchId/call/complete", matchId, userId, CALL_SESSION_ID: prevSessionId, timestamp: new Date().toISOString() });
      const match = await serverStorage.completeCall(matchId, userId);
      if (!match) {
        console.log("[CALL_COMPLETE] CALL_API_RESPONSE", { status: 404, matchId, userId });
        return res.status(404).json({ message: "Match not found" });
      }
      console.log("[CALL_COMPLETE] CALL_API_RESPONSE", { status: 200, matchId, CALL_SESSION_ID: prevSessionId, userId, callStage: match.callStage });
      broadcastCallEvent(matchId, {
        type: "call:ended",
        matchId,
        userId,
      });
      broadcastCallEvent(matchId, {
        type: "call:completed",
        matchId,
        userId,
        callSessionId: prevSessionId,
      });
      res.json(match);
    } catch (error) {
      console.error("[CALL_COMPLETE] Error:", error);
      res.status(500).json({ message: "Failed to complete call" });
    }
  });

  app.post("/api/matches/:matchId/face-call/accept", isAuthenticated, async (req: any, res) => {
    try {
      const serverStorage = new SupabaseStorage();
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
    } catch (error) {
      console.error("Error accepting face call:", error);
      res.status(500).json({ message: "Failed to accept face call" });
    }
  });

  app.post("/api/matches/:matchId/face-call/decline", isAuthenticated, async (req: any, res) => {
    try {
      const serverStorage = new SupabaseStorage();
      const userId = req.user.id;
      console.log("[FACE_CALL_DECLINE] CALL_API_REQUEST", { path: "/api/matches/:matchId/face-call/decline", matchId: req.params.matchId, userId });
      const match = await serverStorage.declineFaceCall(req.params.matchId, userId);
      if (!match) {
        console.log("[FACE_CALL_DECLINE] CALL_API_RESPONSE", { status: 404, matchId: req.params.matchId, userId });
        return res.status(404).json({ message: "Match not found" });
      }
      console.log("[FACE_CALL_DECLINE] CALL_API_RESPONSE", { status: 200, matchId: req.params.matchId, userId });
      res.json(match);
    } catch (error) {
      console.error("Error declining face call:", error);
      res.status(500).json({ message: "Failed to decline face call" });
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
      const spinsThisWeek = await storage.getSpinsThisWeek(userId);
      const dailyLikes = await storage.getDailyLikeCount(userId);
      const consecutiveDays = await storage.getConsecutiveLikeDays(userId, 10);
      const streakComplete = consecutiveDays >= 3;
      const hasUnusedStreak = await storage.hasUnusedStreakSpin(userId);

      let canSpin = false;
      if (streakComplete && hasUnusedStreak) {
        canSpin = true;
      } else if (!streakComplete && spinsThisWeek === 0) {
        canSpin = true;
      }

      res.json({
        spinsThisWeek,
        dailyLikes,
        consecutiveDays,
        streakComplete,
        canSpin,
      });
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

  await seedDatabase();

  return httpServer;
}
