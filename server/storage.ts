import {
  type Profile, type InsertProfile,
  type Interaction, type InsertInteraction,
  type Match, type Message, type InsertMessage,
  type SpinRequest,
  profiles, interactions, matches, messages,
  spinStandouts, spinUsage, spinRequests,
} from "@shared/schema";
import { db } from "./db";
import { eq, and, or, inArray, notInArray, sql, desc } from "drizzle-orm";

function getGendersForPreference(preference: string): string[] | null {
  switch (preference) {
    case "women": return ["woman", "trans woman"];
    case "men": return ["man", "trans man"];
    case "non-binary people": return ["non-binary", "genderqueer", "genderfluid", "agender", "two-spirit", "other"];
    case "trans women": return ["trans woman"];
    case "trans men": return ["trans man"];
    case "everyone": return null;
    default: return null;
  }
}

function getPreferencesThatIncludeGender(gender: string): string[] {
  const prefs = ["everyone"];
  switch (gender) {
    case "woman": prefs.push("women"); break;
    case "man": prefs.push("men"); break;
    case "trans woman": prefs.push("women", "trans women"); break;
    case "trans man": prefs.push("men", "trans men"); break;
    case "non-binary":
    case "genderqueer":
    case "genderfluid":
    case "agender":
    case "two-spirit":
    case "other":
      prefs.push("non-binary people"); break;
  }
  return prefs;
}

function buildGenderFilter(preference: string) {
  const genders = getGendersForPreference(preference);
  if (!genders) return sql`true`;
  return inArray(profiles.gender, genders);
}

function buildReciprocityFilter(myGender: string) {
  const validPrefs = getPreferencesThatIncludeGender(myGender);
  return inArray(profiles.datingPreference, validPrefs);
}

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
  acceptFaceCall(matchId: string, userId: string): Promise<Match | undefined>;
  declineFaceCall(matchId: string, userId: string): Promise<Match | undefined>;
  getPopularProfiles(limit?: number, preference?: string, myGender?: string): Promise<Profile[]>;
  getSpinStandouts(userId: string): Promise<string[]>;
  addSpinStandout(userId: string, standoutUserId: string): Promise<void>;
  getSpinsToday(userId: string): Promise<number>;
  getSpinsThisWeek(userId: string): Promise<number>;
  recordSpin(userId: string): Promise<void>;
  getDailyLikeCount(userId: string): Promise<number>;
  getConsecutiveLikeDays(userId: string, goal: number): Promise<number>;
  hasUnusedStreakSpin(userId: string): Promise<boolean>;
  createSpinRequest(fromUserId: string, toUserId: string, message: string): Promise<SpinRequest>;
  getIncomingSpinRequests(userId: string): Promise<(SpinRequest & { profile: Profile })[]>;
  getOutgoingSpinRequests(userId: string): Promise<(SpinRequest & { profile: Profile })[]>;
  respondToSpinRequest(requestId: string, userId: string, accept: boolean): Promise<SpinRequest | undefined>;
  getSpinRequest(id: string): Promise<SpinRequest | undefined>;
  setMeetAvailability(matchId: string, userId: string, availability: string): Promise<Match | undefined>;
  exchangeNumber(matchId: string, userId: string): Promise<Match | undefined>;
  removeMatch(matchId: string, userId: string): Promise<boolean>;
  getMatchCount(userId: string): Promise<number>;
  getIncomingOpens(userId: string): Promise<(Interaction & { profile: Profile })[]>;
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

    const genderFilter = buildGenderFilter(preference);
    const reciprocityFilter = buildReciprocityFilter(gender);

    const result = await db
      .select()
      .from(profiles)
      .where(
        and(
          sql`${profiles.userId} != ${userId}`,
          sql`${profiles.userId} NOT IN (${interactedUserIds})`,
          eq(profiles.onboardingComplete, true),
          genderFilter,
          reciprocityFilter,
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
    const stage = match.callStage || 0;
    if (stage >= 3) return undefined;
    if (stage === 2 && !(match.faceCallUser1Accepted && match.faceCallUser2Accepted)) return undefined;
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
    const currentStage = match.callStage || 0;
    if (currentStage >= 3) return undefined;
    const nextStage = Math.min(currentStage + 1, 3);
    const [updated] = await db
      .update(matches)
      .set({
        callCompleted: false,
        callStartedAt: null,
        callInitiatorId: null,
        callAnswered: false,
        callStage: nextStage,
      })
      .where(eq(matches.id, matchId))
      .returning();
    return updated;
  }

  async acceptFaceCall(matchId: string, userId: string): Promise<Match | undefined> {
    const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
    if (!match) return undefined;
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    if ((match.callStage || 0) !== 2) return undefined;

    const updates: Record<string, any> = {};
    if (match.user1Id === userId) {
      updates.faceCallUser1Accepted = true;
    } else {
      updates.faceCallUser2Accepted = true;
    }

    const [updated] = await db
      .update(matches)
      .set(updates)
      .where(eq(matches.id, matchId))
      .returning();
    return updated;
  }

  async declineFaceCall(matchId: string, userId: string): Promise<Match | undefined> {
    const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
    if (!match) return undefined;
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    if ((match.callStage || 0) !== 2) return undefined;

    const [updated] = await db
      .update(matches)
      .set({
        callStage: 3,
        faceCallUser1Accepted: false,
        faceCallUser2Accepted: false,
      })
      .where(eq(matches.id, matchId))
      .returning();
    return updated;
  }

  async getPopularProfiles(limit: number = 10, preference?: string, myGender?: string): Promise<Profile[]> {
    const genderFilter = preference ? buildGenderFilter(preference) : sql`true`;
    const reciprocityFilter = myGender ? buildReciprocityFilter(myGender) : sql`true`;

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
        .where(and(eq(profiles.onboardingComplete, true), genderFilter, reciprocityFilter))
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
          genderFilter,
          reciprocityFilter
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
            reciprocityFilter,
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
  async getConsecutiveLikeDays(userId: string, goal: number): Promise<number> {
    const today = new Date();
    let bestStreak = 0;

    for (let startOffset = 0; startOffset <= 1; startOffset++) {
      let streak = 0;
      for (let i = 0; i < 3; i++) {
        const checkDate = new Date(today);
        checkDate.setDate(today.getDate() - startOffset - i);
        const dateStr = checkDate.toISOString().slice(0, 10);

        const result = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(interactions)
          .where(
            and(
              eq(interactions.fromUserId, userId),
              eq(interactions.type, "open"),
              sql`${interactions.createdAt}::date = ${dateStr}::date`
            )
          );

        const count = result[0]?.count || 0;
        if (count >= goal) {
          streak++;
        } else {
          break;
        }
      }
      bestStreak = Math.max(bestStreak, streak);
    }

    return bestStreak;
  }

  async hasUnusedStreakSpin(userId: string): Promise<boolean> {
    const today = new Date();
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(today.getDate() - 3);
    const cutoffDate = threeDaysAgo.toISOString().slice(0, 10);

    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(spinUsage)
      .where(
        and(
          eq(spinUsage.userId, userId),
          sql`${spinUsage.spinDate} >= ${cutoffDate}`
        )
      );
    return (result[0]?.count || 0) === 0;
  }

  async createSpinRequest(fromUserId: string, toUserId: string, message: string): Promise<SpinRequest> {
    const [request] = await db
      .insert(spinRequests)
      .values({ fromUserId, toUserId, message, status: "pending" })
      .returning();
    return request;
  }

  async getIncomingSpinRequests(userId: string): Promise<(SpinRequest & { profile: Profile })[]> {
    const requests = await db
      .select()
      .from(spinRequests)
      .where(and(eq(spinRequests.toUserId, userId), eq(spinRequests.status, "pending")))
      .orderBy(desc(spinRequests.createdAt));

    const results: (SpinRequest & { profile: Profile })[] = [];
    for (const req of requests) {
      const [profile] = await db.select().from(profiles).where(eq(profiles.userId, req.fromUserId));
      if (profile) {
        results.push({ ...req, profile });
      }
    }
    return results;
  }

  async getOutgoingSpinRequests(userId: string): Promise<(SpinRequest & { profile: Profile })[]> {
    const requests = await db
      .select()
      .from(spinRequests)
      .where(eq(spinRequests.fromUserId, userId))
      .orderBy(desc(spinRequests.createdAt));

    const results: (SpinRequest & { profile: Profile })[] = [];
    for (const req of requests) {
      const [profile] = await db.select().from(profiles).where(eq(profiles.userId, req.toUserId));
      if (profile) {
        results.push({ ...req, profile });
      }
    }
    return results;
  }

  async respondToSpinRequest(requestId: string, userId: string, accept: boolean): Promise<SpinRequest | undefined> {
    const [request] = await db
      .select()
      .from(spinRequests)
      .where(and(eq(spinRequests.id, requestId), eq(spinRequests.toUserId, userId)));

    if (!request || request.status !== "pending") return undefined;

    const newStatus = accept ? "accepted" : "declined";
    const [updated] = await db
      .update(spinRequests)
      .set({ status: newStatus })
      .where(eq(spinRequests.id, requestId))
      .returning();

    return updated;
  }

  async getSpinRequest(id: string): Promise<SpinRequest | undefined> {
    const [request] = await db.select().from(spinRequests).where(eq(spinRequests.id, id));
    return request;
  }

  async setMeetAvailability(matchId: string, userId: string, availability: string): Promise<Match | undefined> {
    const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
    if (!match) return undefined;
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    if ((match.callStage || 0) < 3) return undefined;

    const updates: Record<string, any> = {};
    if (match.user1Id === userId) {
      updates.meetAvailability1 = availability;
    } else {
      updates.meetAvailability2 = availability;
    }

    const [updated] = await db.update(matches).set(updates).where(eq(matches.id, matchId)).returning();
    return updated;
  }

  async exchangeNumber(matchId: string, userId: string): Promise<Match | undefined> {
    const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
    if (!match) return undefined;
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    if ((match.callStage || 0) < 3) return undefined;
    if (!match.meetAvailability1 || !match.meetAvailability2) return undefined;
    const mySlots: string[] = JSON.parse(match.user1Id === userId ? match.meetAvailability1 : match.meetAvailability2);
    const theirSlots: string[] = JSON.parse(match.user1Id === userId ? match.meetAvailability2 : match.meetAvailability1);
    const hasMatchingSlots = mySlots.some(s => theirSlots.includes(s));
    if (!hasMatchingSlots) return undefined;

    const updates: Record<string, any> = {};
    if (match.user1Id === userId) {
      updates.numberExchanged1 = true;
    } else {
      updates.numberExchanged2 = true;
    }

    const [updated] = await db.update(matches).set(updates).where(eq(matches.id, matchId)).returning();
    return updated;
  }

  async removeMatch(matchId: string, userId: string): Promise<boolean> {
    const [match] = await db.select().from(matches).where(eq(matches.id, matchId));
    if (!match) return false;
    if (match.user1Id !== userId && match.user2Id !== userId) return false;
    await db.update(matches).set({ status: "removed" }).where(eq(matches.id, matchId));
    return true;
  }

  async getMatchCount(userId: string): Promise<number> {
    const result = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(matches)
      .where(
        and(
          or(eq(matches.user1Id, userId), eq(matches.user2Id, userId)),
          eq(matches.status, "active")
        )
      );
    return result[0]?.count || 0;
  }

  async getIncomingOpens(userId: string): Promise<(Interaction & { profile: Profile })[]> {
    const userInteractedBack = db
      .select({ id: interactions.toUserId })
      .from(interactions)
      .where(eq(interactions.fromUserId, userId));

    const matchedUserIds = db
      .select({ id: matches.user1Id })
      .from(matches)
      .where(and(eq(matches.user2Id, userId), eq(matches.status, "active")));

    const matchedUserIds2 = db
      .select({ id: matches.user2Id })
      .from(matches)
      .where(and(eq(matches.user1Id, userId), eq(matches.status, "active")));

    const incomingOpens = await db
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.toUserId, userId),
          eq(interactions.type, "open"),
          sql`${interactions.fromUserId} NOT IN (${userInteractedBack})`,
          sql`${interactions.fromUserId} NOT IN (${matchedUserIds})`,
          sql`${interactions.fromUserId} NOT IN (${matchedUserIds2})`
        )
      )
      .orderBy(desc(interactions.createdAt));

    const result: (Interaction & { profile: Profile })[] = [];
    for (const open of incomingOpens) {
      const [profile] = await db.select().from(profiles).where(eq(profiles.userId, open.fromUserId));
      if (profile) {
        result.push({ ...open, profile });
      }
    }
    return result;
  }
}

export const storage = new DatabaseStorage();
