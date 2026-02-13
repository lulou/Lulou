import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import { setupAuth, registerAuthRoutes, isAuthenticated } from "./replit_integrations/auth";
import { seedDatabase } from "./seed";
import { z } from "zod";

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
  conversationStarters: z.array(z.string().max(200)).max(3).optional(),
  questions: z.array(z.string().max(200)).max(3).optional(),
  locationRadius: z.number().int().min(5).max(100).optional(),
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
      const discovered = await storage.getDiscoverProfiles(userId, myProfile.gender, myProfile.datingPreference);
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

      res.json(message);
    } catch (error) {
      console.error("Error sending message:", error);
      res.status(500).json({ message: "Failed to send message" });
    }
  });

  await seedDatabase();

  return httpServer;
}
