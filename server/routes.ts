import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, registerAuthRoutes, isAuthenticated } from "./replit_integrations/auth";
import { seedDatabase } from "./seed";
import { z } from "zod";
import type { Profile } from "@shared/schema";

const profileBodySchema = z.object({
  firstName: z.string().min(1).max(50),
  age: z.number().int().min(18).max(99),
  gender: z.enum(["woman", "man", "non-binary"]),
  datingPreference: z.enum(["women", "men", "everyone"]),
  location: z.string().min(1).max(100),
  height: z.string().max(10).optional(),
  photos: z.array(z.string()).min(1).max(6),
  signals: z.array(z.string()).min(1).max(5),
  datingIntent: z.string().min(1),
  greenFlags: z.array(z.string()).min(3).max(4),
  connectionStyle: z.string().min(1),
  conversationStarters: z.array(z.string().max(200)).min(2).max(3).optional(),
  questions: z.array(z.string().max(200)).min(2).max(3).optional(),
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
  await setupAuth(app);
  registerAuthRoutes(app);

  app.get("/api/profile", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
      const existing = await storage.getProfile(userId);

      if (existing) {
        const parsed = profileUpdateSchema.safeParse(req.body);
        if (!parsed.success) {
          return res.status(400).json({ message: "Invalid profile data", errors: parsed.error.flatten() });
        }
        const updated = await storage.updateProfile(userId, { ...parsed.data, userId });
        return res.json(updated);
      }

      const parsed = profileBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid profile data", errors: parsed.error.flatten() });
      }
      const profile = await storage.createProfile({ ...parsed.data, userId });
      res.json(profile);
    } catch (error) {
      console.error("Error creating profile:", error);
      res.status(500).json({ message: "Failed to create profile" });
    }
  });

  app.get("/api/discover", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
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
      const fromUserId = req.user.claims.sub;
      const parsed = interactionBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid interaction data" });
      }

      const { toUserId, type } = parsed.data;

      const existing = await storage.getInteraction(fromUserId, toUserId);
      if (existing) {
        return res.status(400).json({ message: "Already interacted" });
      }

      const interaction = await storage.createInteraction({ fromUserId, toUserId, type });

      let matched = false;
      if (type === "open") {
        const isMutual = await storage.getMutualOpen(fromUserId, toUserId);
        if (isMutual) {
          await storage.createMatch(fromUserId, toUserId);
          matched = true;
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
      const userId = req.user.claims.sub;
      const userMatches = await storage.getMatchesForUser(userId);
      res.json(userMatches);
    } catch (error) {
      console.error("Error fetching matches:", error);
      res.status(500).json({ message: "Failed to fetch matches" });
    }
  });

  app.get("/api/matches/:matchId", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
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
      const userId = req.user.claims.sub;
      const { matchId } = req.params;
      const parsed = messageBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: "Invalid message" });
      }

      const { content } = parsed.data;

      const match = await storage.getMatch(matchId, userId);
      if (!match) {
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
          setTimeout(async () => {
            try {
              const reply = generateAutoReply(otherProfile, otherCount);
              await storage.createMessage({
                matchId,
                senderId: otherUserId,
                content: reply,
              });
              await storage.incrementMessageCount(matchId, otherUserId);
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
      const userId = req.user.claims.sub;
      const match = await storage.startCall(req.params.matchId, userId);
      if (!match) {
        return res.status(404).json({ message: "Match not found" });
      }

      const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;
      if (otherUserId.startsWith("seed-")) {
        setTimeout(async () => {
          try {
            await storage.answerCall(req.params.matchId, otherUserId);
          } catch (err) {
            console.error("Auto-answer error:", err);
          }
        }, 2000 + Math.random() * 2000);
      }

      res.json(match);
    } catch (error) {
      console.error("Error starting call:", error);
      res.status(500).json({ message: "Failed to start call" });
    }
  });

  app.post("/api/matches/:matchId/call/answer", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const match = await storage.answerCall(req.params.matchId, userId);
      if (!match) {
        return res.status(404).json({ message: "Match not found or you cannot answer your own call" });
      }
      res.json(match);
    } catch (error) {
      console.error("Error answering call:", error);
      res.status(500).json({ message: "Failed to answer call" });
    }
  });

  app.post("/api/matches/:matchId/call/cancel", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const match = await storage.cancelCall(req.params.matchId, userId);
      if (!match) {
        return res.status(404).json({ message: "Match not found" });
      }
      res.json(match);
    } catch (error) {
      console.error("Error cancelling call:", error);
      res.status(500).json({ message: "Failed to cancel call" });
    }
  });

  app.post("/api/matches/:matchId/call/complete", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const match = await storage.completeCall(req.params.matchId, userId);
      if (!match) {
        return res.status(404).json({ message: "Match not found" });
      }
      res.json(match);
    } catch (error) {
      console.error("Error completing call:", error);
      res.status(500).json({ message: "Failed to complete call" });
    }
  });

  app.get("/api/popular", isAuthenticated, async (req: any, res) => {
    try {
      const userId = req.user.claims.sub;
      const myProfile = await storage.getProfile(userId);
      const preference = myProfile?.datingPreference;
      const popular = await storage.getPopularProfiles(10, preference);
      res.json(popular);
    } catch (error) {
      console.error("Error fetching popular profiles:", error);
      res.status(500).json({ message: "Failed to fetch popular profiles" });
    }
  });

  await seedDatabase();

  return httpServer;
}
