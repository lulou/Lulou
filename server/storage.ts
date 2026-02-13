import {
  type Profile, type InsertProfile,
  type Interaction, type InsertInteraction,
  type Match, type Message, type InsertMessage,
  profiles, interactions, matches, messages,
} from "@shared/schema";
import { db } from "./db";
import { eq, and, or, notInArray, sql, desc } from "drizzle-orm";

export interface IStorage {
  getProfile(userId: string): Promise<Profile | undefined>;
  createProfile(data: InsertProfile): Promise<Profile>;
  updateProfile(userId: string, data: Partial<InsertProfile>): Promise<Profile | undefined>;
  getDiscoverProfiles(userId: string, gender: string, preference: string): Promise<Profile[]>;
  createInteraction(data: InsertInteraction): Promise<Interaction>;
  getInteraction(fromUserId: string, toUserId: string): Promise<Interaction | undefined>;
  getMutualOpen(user1Id: string, user2Id: string): Promise<boolean>;
  createMatch(user1Id: string, user2Id: string): Promise<Match>;
  getMatchesForUser(userId: string): Promise<(Match & { profile: Profile })[]>;
  getMatch(matchId: string, userId: string): Promise<(Match & { profile: Profile; messages: Message[] }) | undefined>;
  createMessage(data: InsertMessage): Promise<Message>;
  getUserMessageCount(matchId: string, userId: string): Promise<number>;
  incrementMessageCount(matchId: string, userId: string): Promise<void>;
  startCall(matchId: string, userId: string): Promise<Match | undefined>;
  completeCall(matchId: string, userId: string): Promise<Match | undefined>;
}

export class DatabaseStorage implements IStorage {
  async getProfile(userId: string): Promise<Profile | undefined> {
    const [profile] = await db.select().from(profiles).where(eq(profiles.userId, userId));
    return profile || undefined;
  }

  async createProfile(data: InsertProfile): Promise<Profile> {
    const [profile] = await db.insert(profiles).values(data).returning();
    return profile;
  }

  async updateProfile(userId: string, data: Partial<InsertProfile>): Promise<Profile | undefined> {
    const [profile] = await db.update(profiles).set(data).where(eq(profiles.userId, userId)).returning();
    return profile || undefined;
  }

  async getDiscoverProfiles(userId: string, gender: string, preference: string): Promise<Profile[]> {
    const interactedUserIds = db
      .select({ id: interactions.toUserId })
      .from(interactions)
      .where(eq(interactions.fromUserId, userId));

    let genderFilter;
    if (preference === "women") {
      genderFilter = eq(profiles.gender, "woman");
    } else if (preference === "men") {
      genderFilter = eq(profiles.gender, "man");
    } else {
      genderFilter = sql`true`;
    }

    const result = await db
      .select()
      .from(profiles)
      .where(
        and(
          sql`${profiles.userId} != ${userId}`,
          sql`${profiles.userId} NOT IN (${interactedUserIds})`,
          eq(profiles.onboardingComplete, true),
          genderFilter
        )
      )
      .limit(5);

    return result;
  }

  async createInteraction(data: InsertInteraction): Promise<Interaction> {
    const [interaction] = await db.insert(interactions).values(data).returning();
    return interaction;
  }

  async getInteraction(fromUserId: string, toUserId: string): Promise<Interaction | undefined> {
    const [interaction] = await db
      .select()
      .from(interactions)
      .where(and(eq(interactions.fromUserId, fromUserId), eq(interactions.toUserId, toUserId)));
    return interaction || undefined;
  }

  async getMutualOpen(user1Id: string, user2Id: string): Promise<boolean> {
    const [reverse] = await db
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.fromUserId, user2Id),
          eq(interactions.toUserId, user1Id),
          eq(interactions.type, "open")
        )
      );
    return !!reverse;
  }

  async createMatch(user1Id: string, user2Id: string): Promise<Match> {
    const [match] = await db.insert(matches).values({ user1Id, user2Id }).returning();
    return match;
  }

  async getMatchesForUser(userId: string): Promise<(Match & { profile: Profile })[]> {
    const userMatches = await db
      .select()
      .from(matches)
      .where(
        and(
          or(eq(matches.user1Id, userId), eq(matches.user2Id, userId)),
          eq(matches.status, "active")
        )
      )
      .orderBy(desc(matches.createdAt));

    const result: (Match & { profile: Profile })[] = [];
    for (const match of userMatches) {
      const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;
      const [profile] = await db.select().from(profiles).where(eq(profiles.userId, otherUserId));
      if (profile) {
        result.push({ ...match, profile });
      }
    }
    return result;
  }

  async getMatch(matchId: string, userId: string): Promise<(Match & { profile: Profile; messages: Message[] }) | undefined> {
    const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
    if (!match) return undefined;
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;

    const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;
    const [profile] = await db.select().from(profiles).where(eq(profiles.userId, otherUserId));
    if (!profile) return undefined;

    const matchMessages = await db
      .select()
      .from(messages)
      .where(eq(messages.matchId, matchId))
      .orderBy(messages.createdAt);

    return { ...match, profile, messages: matchMessages };
  }

  async createMessage(data: InsertMessage): Promise<Message> {
    const [message] = await db.insert(messages).values(data).returning();
    return message;
  }

  async getUserMessageCount(matchId: string, userId: string): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(messages)
      .where(and(eq(messages.matchId, matchId), eq(messages.senderId, userId)));
    return result[0]?.count || 0;
  }

  async incrementMessageCount(matchId: string, userId: string): Promise<void> {
    const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
    if (!match) return;
    if (match.user1Id === userId) {
      await db.update(matches).set({ messageCount1: (match.messageCount1 || 0) + 1 }).where(eq(matches.id, matchId));
    } else {
      await db.update(matches).set({ messageCount2: (match.messageCount2 || 0) + 1 }).where(eq(matches.id, matchId));
    }
  }
  async startCall(matchId: string, userId: string): Promise<Match | undefined> {
    const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
    if (!match) return undefined;
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    const [updated] = await db
      .update(matches)
      .set({ callStartedAt: new Date() })
      .where(eq(matches.id, matchId))
      .returning();
    return updated;
  }

  async completeCall(matchId: string, userId: string): Promise<Match | undefined> {
    const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
    if (!match) return undefined;
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    const [updated] = await db
      .update(matches)
      .set({ callCompleted: true })
      .where(eq(matches.id, matchId))
      .returning();
    return updated;
  }
}

export const storage = new DatabaseStorage();
