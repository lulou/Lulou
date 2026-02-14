import {
  type Profile, type InsertProfile,
  type Interaction, type InsertInteraction,
  type Match, type Message, type InsertMessage,
  profiles, interactions, matches, messages,
  spinStandouts, spinUsage,
} from "@shared/schema";
import { db } from "./db";
import { eq, and, or, notInArray, sql, desc } from "drizzle-orm";

export interface IStorage {
  getProfile(userId: string): Promise<Profile | undefined>;
  createProfile(data: InsertProfile): Promise<Profile>;
  updateProfile(userId: string, data: Partial<InsertProfile>): Promise<Profile | undefined>;
  getDiscoverProfiles(userId: string, gender: string, preference: string, ageMin?: number, ageMax?: number): Promise<Profile[]>;
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
  answerCall(matchId: string, userId: string): Promise<Match | undefined>;
  cancelCall(matchId: string, userId: string): Promise<Match | undefined>;
  completeCall(matchId: string, userId: string): Promise<Match | undefined>;
  getPopularProfiles(limit?: number, preference?: string): Promise<Profile[]>;
  getSpinStandouts(userId: string): Promise<string[]>;
  addSpinStandout(userId: string, standoutUserId: string): Promise<void>;
  getSpinsToday(userId: string): Promise<number>;
  getSpinsThisWeek(userId: string): Promise<number>;
  recordSpin(userId: string): Promise<void>;
  getDailyLikeCount(userId: string): Promise<number>;
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

  async getDiscoverProfiles(userId: string, gender: string, preference: string, ageMin: number = 18, ageMax: number = 45): Promise<Profile[]> {
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
          genderFilter,
          sql`${profiles.age} >= ${ageMin}`,
          sql`${profiles.age} <= ${ageMax}`
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
      .set({ callStartedAt: new Date(), callInitiatorId: userId, callAnswered: false, callCompleted: false })
      .where(eq(matches.id, matchId))
      .returning();
    return updated;
  }

  async answerCall(matchId: string, userId: string): Promise<Match | undefined> {
    const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
    if (!match) return undefined;
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    if (match.callInitiatorId === userId) return undefined;
    const [updated] = await db
      .update(matches)
      .set({ callAnswered: true, callStartedAt: new Date() })
      .where(eq(matches.id, matchId))
      .returning();
    return updated;
  }

  async cancelCall(matchId: string, userId: string): Promise<Match | undefined> {
    const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
    if (!match) return undefined;
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    const [updated] = await db
      .update(matches)
      .set({ callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false })
      .where(eq(matches.id, matchId))
      .returning();
    return updated;
  }

  async completeCall(matchId: string, userId: string): Promise<Match | undefined> {
    const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
    if (!match) return undefined;
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    if (!match.callAnswered) {
      const [updated] = await db
        .update(matches)
        .set({ callStartedAt: null, callInitiatorId: null, callAnswered: false, callCompleted: false })
        .where(eq(matches.id, matchId))
        .returning();
      return updated;
    }
    const [updated] = await db
      .update(matches)
      .set({ callCompleted: true })
      .where(eq(matches.id, matchId))
      .returning();
    return updated;
  }

  async getPopularProfiles(limit: number = 10, preference?: string): Promise<Profile[]> {
    let genderFilter;
    if (preference === "women") {
      genderFilter = eq(profiles.gender, "woman");
    } else if (preference === "men") {
      genderFilter = eq(profiles.gender, "man");
    } else {
      genderFilter = sql`true`;
    }

    const popularUserIds = db
      .select({
        userId: interactions.toUserId,
        openCount: sql<number>`count(*)::int`.as("open_count"),
      })
      .from(interactions)
      .where(eq(interactions.type, "open"))
      .groupBy(interactions.toUserId)
      .orderBy(sql`count(*) DESC`)
      .limit(limit);

    const subquery = await popularUserIds;

    if (subquery.length === 0) {
      const fallback = await db
        .select()
        .from(profiles)
        .where(and(eq(profiles.onboardingComplete, true), genderFilter))
        .limit(limit);
      return fallback;
    }

    const userIds = subquery.map((r) => r.userId);
    const result = await db
      .select()
      .from(profiles)
      .where(
        and(
          sql`${profiles.userId} IN (${sql.join(userIds.map(id => sql`${id}`), sql`, `)})`,
          eq(profiles.onboardingComplete, true),
          genderFilter
        )
      );

    const orderMap = new Map(userIds.map((id, i) => [id, i]));
    result.sort((a, b) => (orderMap.get(a.userId) ?? 99) - (orderMap.get(b.userId) ?? 99));

    if (result.length < limit) {
      const existingIds = result.map(r => r.userId);
      const extraFilter = existingIds.length > 0
        ? sql`${profiles.userId} NOT IN (${sql.join(existingIds.map(id => sql`${id}`), sql`, `)})`
        : sql`true`;
      const extra = await db
        .select()
        .from(profiles)
        .where(
          and(
            eq(profiles.onboardingComplete, true),
            genderFilter,
            extraFilter
          )
        )
        .limit(limit - result.length);
      result.push(...extra);
    }

    return result;
  }

  async getSpinStandouts(userId: string): Promise<string[]> {
    const rows = await db
      .select({ standoutUserId: spinStandouts.standoutUserId })
      .from(spinStandouts)
      .where(eq(spinStandouts.userId, userId));
    return rows.map(r => r.standoutUserId);
  }

  async addSpinStandout(userId: string, standoutUserId: string): Promise<void> {
    await db.insert(spinStandouts).values({ userId, standoutUserId });
  }

  async getSpinsToday(userId: string): Promise<number> {
    const today = new Date().toISOString().slice(0, 10);
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(spinUsage)
      .where(and(eq(spinUsage.userId, userId), eq(spinUsage.spinDate, today)));
    return result[0]?.count || 0;
  }

  async getSpinsThisWeek(userId: string): Promise<number> {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
    const weekStart = monday.toISOString().slice(0, 10);
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(spinUsage)
      .where(and(eq(spinUsage.userId, userId), sql`${spinUsage.spinDate} >= ${weekStart}`));
    return result[0]?.count || 0;
  }

  async recordSpin(userId: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    await db.insert(spinUsage).values({ userId, spinDate: today });
  }

  async getDailyLikeCount(userId: string): Promise<number> {
    const today = new Date().toISOString().slice(0, 10);
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(interactions)
      .where(
        and(
          eq(interactions.fromUserId, userId),
          eq(interactions.type, "open"),
          sql`${interactions.createdAt}::date = ${today}::date`
        )
      );
    return result[0]?.count || 0;
  }
}

export const storage = new DatabaseStorage();
