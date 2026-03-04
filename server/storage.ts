import {
  type Profile, type InsertProfile,
  type Interaction, type InsertInteraction,
  type Match, type Message, type InsertMessage,
  type SpinRequest,
} from "@shared/schema";
import { supabase } from "./supabase";

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

function mapProfile(row: any): Profile {
  return {
    id: row.id,
    userId: row.user_id,
    firstName: row.first_name,
    age: row.age,
    gender: row.gender,
    datingPreference: row.dating_preference,
    location: row.location,
    height: row.height,
    photos: row.photos,
    signals: row.signals,
    datingIntent: row.dating_intent,
    greenFlags: row.green_flags,
    connectionStyle: row.connection_style,
    conversationStarters: row.conversation_starters,
    questions: row.questions,
    locationRadius: row.location_radius,
    preferredAgeMin: row.preferred_age_min,
    preferredAgeMax: row.preferred_age_max,
    email: row.email,
    phoneNumber: row.phone_number,
    photoVerified: row.photo_verified,
    onboardingComplete: row.onboarding_complete,
    createdAt: row.created_at ? new Date(row.created_at) : null,
  };
}

function mapInteraction(row: any): Interaction {
  return {
    id: row.id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    type: row.type,
    createdAt: row.created_at ? new Date(row.created_at) : null,
  };
}

function mapMatch(row: any): Match {
  return {
    id: row.id,
    user1Id: row.user1_id,
    user2Id: row.user2_id,
    messageCount1: row.message_count_1,
    messageCount2: row.message_count_2,
    callCompleted: row.call_completed,
    callStartedAt: row.call_started_at ? new Date(row.call_started_at) : null,
    callAnswered: row.call_answered,
    callInitiatorId: row.call_initiator_id,
    callStage: row.call_stage,
    faceCallUser1Accepted: row.face_call_user1_accepted,
    faceCallUser2Accepted: row.face_call_user2_accepted,
    meetAvailability1: row.meet_availability_1,
    meetAvailability2: row.meet_availability_2,
    numberExchanged1: row.number_exchanged_1,
    numberExchanged2: row.number_exchanged_2,
    status: row.status,
    createdAt: row.created_at ? new Date(row.created_at) : null,
  };
}

function mapMessage(row: any): Message {
  return {
    id: row.id,
    matchId: row.match_id,
    senderId: row.sender_id,
    content: row.content,
    createdAt: row.created_at ? new Date(row.created_at) : null,
  };
}

function mapSpinRequest(row: any): SpinRequest {
  return {
    id: row.id,
    fromUserId: row.from_user_id,
    toUserId: row.to_user_id,
    message: row.message,
    status: row.status,
    createdAt: row.created_at ? new Date(row.created_at) : null,
  };
}

function profileToDbRow(data: Partial<InsertProfile>): Record<string, any> {
  const row: Record<string, any> = {};
  if (data.userId !== undefined) row.user_id = data.userId;
  if (data.firstName !== undefined) row.first_name = data.firstName;
  if (data.age !== undefined) row.age = data.age;
  if (data.gender !== undefined) row.gender = data.gender;
  if (data.datingPreference !== undefined) row.dating_preference = data.datingPreference;
  if (data.location !== undefined) row.location = data.location;
  if (data.height !== undefined) row.height = data.height;
  if (data.photos !== undefined) row.photos = data.photos;
  if (data.signals !== undefined) row.signals = data.signals;
  if (data.datingIntent !== undefined) row.dating_intent = data.datingIntent;
  if (data.greenFlags !== undefined) row.green_flags = data.greenFlags;
  if (data.connectionStyle !== undefined) row.connection_style = data.connectionStyle;
  if (data.conversationStarters !== undefined) row.conversation_starters = data.conversationStarters;
  if (data.questions !== undefined) row.questions = data.questions;
  if (data.locationRadius !== undefined) row.location_radius = data.locationRadius;
  if (data.preferredAgeMin !== undefined) row.preferred_age_min = data.preferredAgeMin;
  if (data.preferredAgeMax !== undefined) row.preferred_age_max = data.preferredAgeMax;
  if (data.email !== undefined) row.email = data.email;
  if (data.phoneNumber !== undefined) row.phone_number = data.phoneNumber;
  if (data.photoVerified !== undefined) row.photo_verified = data.photoVerified;
  if (data.onboardingComplete !== undefined) row.onboarding_complete = data.onboardingComplete;
  return row;
}

export class SupabaseStorage implements IStorage {
  async getProfile(userId: string): Promise<Profile | undefined> {
    const { data, error } = await supabase
      .from("profiles")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    if (error || !data) return undefined;
    return mapProfile(data);
  }

  async createProfile(data: InsertProfile): Promise<Profile> {
    const row = profileToDbRow(data);
    row.user_id = data.userId;
    const { data: result, error } = await supabase
      .from("profiles")
      .upsert(row, { onConflict: "user_id" })
      .select()
      .single();
    if (error) throw new Error(`Failed to create profile: ${error.message}`);
    return mapProfile(result);
  }

  async updateProfile(userId: string, data: Partial<InsertProfile>): Promise<Profile | undefined> {
    const row = profileToDbRow(data);
    row.user_id = userId;
    const { data: result, error } = await supabase
      .from("profiles")
      .upsert(row, { onConflict: "user_id" })
      .select()
      .single();
    if (error || !result) return undefined;
    return mapProfile(result);
  }

  async getDiscoverProfiles(userId: string, gender: string, preference: string, ageMin: number = 18, ageMax: number = 45): Promise<Profile[]> {
    const { data: interacted } = await supabase
      .from("interactions")
      .select("to_user_id")
      .eq("from_user_id", userId);
    const interactedIds = (interacted || []).map(r => r.to_user_id);

    let query = supabase
      .from("profiles")
      .select("*")
      .neq("user_id", userId)
      .eq("onboarding_complete", true)
      .gte("age", ageMin)
      .lte("age", ageMax);

    if (interactedIds.length > 0) {
      query = query.not("user_id", "in", `(${interactedIds.join(",")})`);
    }

    const genders = getGendersForPreference(preference);
    if (genders) {
      query = query.in("gender", genders);
    }

    const validPrefs = getPreferencesThatIncludeGender(gender);
    query = query.in("dating_preference", validPrefs);

    const { data, error } = await query.limit(5);
    if (error) return [];
    return (data || []).map(mapProfile);
  }

  async createInteraction(data: InsertInteraction): Promise<Interaction> {
    const { data: result, error } = await supabase
      .from("interactions")
      .insert({
        from_user_id: data.fromUserId,
        to_user_id: data.toUserId,
        type: data.type,
      })
      .select()
      .single();
    if (error) throw new Error(`Failed to create interaction: ${error.message}`);
    return mapInteraction(result);
  }

  async getInteraction(fromUserId: string, toUserId: string): Promise<Interaction | undefined> {
    const { data, error } = await supabase
      .from("interactions")
      .select("*")
      .eq("from_user_id", fromUserId)
      .eq("to_user_id", toUserId)
      .maybeSingle();
    if (error || !data) return undefined;
    return mapInteraction(data);
  }

  async getMutualOpen(user1Id: string, user2Id: string): Promise<boolean> {
    const { data, error } = await supabase
      .from("interactions")
      .select("id")
      .eq("from_user_id", user2Id)
      .eq("to_user_id", user1Id)
      .eq("type", "open")
      .maybeSingle();
    return !!data && !error;
  }

  async createMatch(user1Id: string, user2Id: string): Promise<Match> {
    const { data: result, error } = await supabase
      .from("matches")
      .insert({ user1_id: user1Id, user2_id: user2Id })
      .select()
      .single();
    if (error) throw new Error(`Failed to create match: ${error.message}`);
    return mapMatch(result);
  }

  async getMatchesForUser(userId: string): Promise<(Match & { profile: Profile })[]> {
    const { data: userMatches, error } = await supabase
      .from("matches")
      .select("*")
      .eq("status", "active")
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`)
      .order("created_at", { ascending: false });

    if (error || !userMatches) return [];

    const result: (Match & { profile: Profile })[] = [];
    for (const row of userMatches) {
      const match = mapMatch(row);
      const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;
      const { data: profileData } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", otherUserId)
        .maybeSingle();
      if (profileData) {
        result.push({ ...match, profile: mapProfile(profileData) });
      }
    }
    return result;
  }

  async getMatch(matchId: string, userId: string): Promise<(Match & { profile: Profile; messages: Message[] }) | undefined> {
    const { data: matchData, error } = await supabase
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (error || !matchData) return undefined;

    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;

    const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;
    const { data: profileData } = await supabase
      .from("profiles")
      .select("*")
      .eq("user_id", otherUserId)
      .maybeSingle();
    if (!profileData) return undefined;

    const { data: msgData } = await supabase
      .from("messages")
      .select("*")
      .eq("match_id", matchId)
      .order("created_at", { ascending: true });

    return {
      ...match,
      profile: mapProfile(profileData),
      messages: (msgData || []).map(mapMessage),
    };
  }

  async createMessage(data: InsertMessage): Promise<Message> {
    const { data: result, error } = await supabase
      .from("messages")
      .insert({
        match_id: data.matchId,
        sender_id: data.senderId,
        content: data.content,
      })
      .select()
      .single();
    if (error) throw new Error(`Failed to create message: ${error.message}`);
    return mapMessage(result);
  }

  async getUserMessageCount(matchId: string, userId: string): Promise<number> {
    const { count, error } = await supabase
      .from("messages")
      .select("*", { count: "exact", head: true })
      .eq("match_id", matchId)
      .eq("sender_id", userId);
    return count || 0;
  }

  async incrementMessageCount(matchId: string, userId: string): Promise<void> {
    const { data: matchData } = await supabase
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return;
    const match = mapMatch(matchData);

    if (match.user1Id === userId) {
      await supabase
        .from("matches")
        .update({ message_count_1: (match.messageCount1 || 0) + 1 })
        .eq("id", matchId);
    } else {
      await supabase
        .from("matches")
        .update({ message_count_2: (match.messageCount2 || 0) + 1 })
        .eq("id", matchId);
    }
  }

  async startCall(matchId: string, userId: string): Promise<Match | undefined> {
    const { data: matchData } = await supabase
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return undefined;
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    const stage = match.callStage || 0;
    if (stage >= 3) return undefined;
    if (stage === 2 && !(match.faceCallUser1Accepted && match.faceCallUser2Accepted)) return undefined;

    const { data: updated, error } = await supabase
      .from("matches")
      .update({
        call_started_at: new Date().toISOString(),
        call_initiator_id: userId,
        call_answered: false,
        call_completed: false,
      })
      .eq("id", matchId)
      .select()
      .single();
    if (error || !updated) return undefined;
    return mapMatch(updated);
  }

  async answerCall(matchId: string, userId: string): Promise<Match | undefined> {
    const { data: matchData } = await supabase
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return undefined;
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    if (match.callInitiatorId === userId) return undefined;

    const { data: updated, error } = await supabase
      .from("matches")
      .update({
        call_answered: true,
        call_started_at: new Date().toISOString(),
      })
      .eq("id", matchId)
      .select()
      .single();
    if (error || !updated) return undefined;
    return mapMatch(updated);
  }

  async cancelCall(matchId: string, userId: string): Promise<Match | undefined> {
    const { data: matchData } = await supabase
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return undefined;
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;

    const { data: updated, error } = await supabase
      .from("matches")
      .update({
        call_started_at: null,
        call_initiator_id: null,
        call_answered: false,
        call_completed: false,
      })
      .eq("id", matchId)
      .select()
      .single();
    if (error || !updated) return undefined;
    return mapMatch(updated);
  }

  async completeCall(matchId: string, userId: string): Promise<Match | undefined> {
    const { data: matchData } = await supabase
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return undefined;
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;

    if (!match.callAnswered) {
      const { data: updated } = await supabase
        .from("matches")
        .update({
          call_started_at: null,
          call_initiator_id: null,
          call_answered: false,
          call_completed: false,
        })
        .eq("id", matchId)
        .select()
        .single();
      return updated ? mapMatch(updated) : undefined;
    }

    const currentStage = match.callStage || 0;
    if (currentStage >= 3) return undefined;
    const nextStage = Math.min(currentStage + 1, 3);

    const { data: updated } = await supabase
      .from("matches")
      .update({
        call_completed: false,
        call_started_at: null,
        call_initiator_id: null,
        call_answered: false,
        call_stage: nextStage,
      })
      .eq("id", matchId)
      .select()
      .single();
    return updated ? mapMatch(updated) : undefined;
  }

  async acceptFaceCall(matchId: string, userId: string): Promise<Match | undefined> {
    const { data: matchData } = await supabase
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return undefined;
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    if ((match.callStage || 0) !== 2) return undefined;

    const updates: Record<string, any> = {};
    if (match.user1Id === userId) {
      updates.face_call_user1_accepted = true;
    } else {
      updates.face_call_user2_accepted = true;
    }

    const { data: updated } = await supabase
      .from("matches")
      .update(updates)
      .eq("id", matchId)
      .select()
      .single();
    return updated ? mapMatch(updated) : undefined;
  }

  async declineFaceCall(matchId: string, userId: string): Promise<Match | undefined> {
    const { data: matchData } = await supabase
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return undefined;
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    if ((match.callStage || 0) !== 2) return undefined;

    const { data: updated } = await supabase
      .from("matches")
      .update({
        call_stage: 3,
        face_call_user1_accepted: false,
        face_call_user2_accepted: false,
      })
      .eq("id", matchId)
      .select()
      .single();
    return updated ? mapMatch(updated) : undefined;
  }

  async getPopularProfiles(limit: number = 10, preference?: string, myGender?: string): Promise<Profile[]> {
    const { data: popularRows } = await supabase
      .from("interactions")
      .select("to_user_id")
      .eq("type", "open");

    const countMap = new Map<string, number>();
    for (const row of popularRows || []) {
      countMap.set(row.to_user_id, (countMap.get(row.to_user_id) || 0) + 1);
    }
    const sortedIds = [...countMap.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id]) => id);

    let allProfiles: Profile[] = [];

    if (sortedIds.length > 0) {
      let query = supabase
        .from("profiles")
        .select("*")
        .eq("onboarding_complete", true)
        .in("user_id", sortedIds);

      if (preference) {
        const genders = getGendersForPreference(preference);
        if (genders) query = query.in("gender", genders);
      }
      if (myGender) {
        const validPrefs = getPreferencesThatIncludeGender(myGender);
        query = query.in("dating_preference", validPrefs);
      }

      const { data } = await query;
      allProfiles = (data || []).map(mapProfile);

      const orderMap = new Map(sortedIds.map((id, i) => [id, i]));
      allProfiles.sort((a, b) => (orderMap.get(a.userId) ?? 99) - (orderMap.get(b.userId) ?? 99));
    }

    if (allProfiles.length < limit) {
      const existingIds = allProfiles.map(r => r.userId);
      let query = supabase
        .from("profiles")
        .select("*")
        .eq("onboarding_complete", true)
        .limit(limit - allProfiles.length);

      if (existingIds.length > 0) {
        query = query.not("user_id", "in", `(${existingIds.join(",")})`);
      }
      if (preference) {
        const genders = getGendersForPreference(preference);
        if (genders) query = query.in("gender", genders);
      }
      if (myGender) {
        const validPrefs = getPreferencesThatIncludeGender(myGender);
        query = query.in("dating_preference", validPrefs);
      }

      const { data: extra } = await query;
      allProfiles.push(...(extra || []).map(mapProfile));
    }

    return allProfiles;
  }

  async getSpinStandouts(userId: string): Promise<string[]> {
    const { data } = await supabase
      .from("spin_standouts")
      .select("standout_user_id")
      .eq("user_id", userId);
    return (data || []).map(r => r.standout_user_id);
  }

  async addSpinStandout(userId: string, standoutUserId: string): Promise<void> {
    await supabase
      .from("spin_standouts")
      .insert({ user_id: userId, standout_user_id: standoutUserId });
  }

  async getSpinsToday(userId: string): Promise<number> {
    const today = new Date().toISOString().slice(0, 10);
    const { count } = await supabase
      .from("spin_usage")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .eq("spin_date", today);
    return count || 0;
  }

  async getSpinsThisWeek(userId: string): Promise<number> {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((dayOfWeek + 6) % 7));
    const weekStart = monday.toISOString().slice(0, 10);

    const { count } = await supabase
      .from("spin_usage")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("spin_date", weekStart);
    return count || 0;
  }

  async recordSpin(userId: string): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    await supabase
      .from("spin_usage")
      .insert({ user_id: userId, spin_date: today });
  }

  async getDailyLikeCount(userId: string): Promise<number> {
    const today = new Date().toISOString().slice(0, 10);
    const startOfDay = `${today}T00:00:00.000Z`;
    const endOfDay = `${today}T23:59:59.999Z`;

    const { count } = await supabase
      .from("interactions")
      .select("*", { count: "exact", head: true })
      .eq("from_user_id", userId)
      .eq("type", "open")
      .gte("created_at", startOfDay)
      .lte("created_at", endOfDay);
    return count || 0;
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
        const startOfDay = `${dateStr}T00:00:00.000Z`;
        const endOfDay = `${dateStr}T23:59:59.999Z`;

        const { count } = await supabase
          .from("interactions")
          .select("*", { count: "exact", head: true })
          .eq("from_user_id", userId)
          .eq("type", "open")
          .gte("created_at", startOfDay)
          .lte("created_at", endOfDay);

        if ((count || 0) >= goal) {
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

    const { count } = await supabase
      .from("spin_usage")
      .select("*", { count: "exact", head: true })
      .eq("user_id", userId)
      .gte("spin_date", cutoffDate);
    return (count || 0) === 0;
  }

  async createSpinRequest(fromUserId: string, toUserId: string, message: string): Promise<SpinRequest> {
    const { data: result, error } = await supabase
      .from("spin_requests")
      .insert({
        from_user_id: fromUserId,
        to_user_id: toUserId,
        message,
        status: "pending",
      })
      .select()
      .single();
    if (error) throw new Error(`Failed to create spin request: ${error.message}`);
    return mapSpinRequest(result);
  }

  async getIncomingSpinRequests(userId: string): Promise<(SpinRequest & { profile: Profile })[]> {
    const { data: requests } = await supabase
      .from("spin_requests")
      .select("*")
      .eq("to_user_id", userId)
      .eq("status", "pending")
      .order("created_at", { ascending: false });

    const results: (SpinRequest & { profile: Profile })[] = [];
    for (const req of requests || []) {
      const { data: profileData } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", req.from_user_id)
        .maybeSingle();
      if (profileData) {
        results.push({ ...mapSpinRequest(req), profile: mapProfile(profileData) });
      }
    }
    return results;
  }

  async getOutgoingSpinRequests(userId: string): Promise<(SpinRequest & { profile: Profile })[]> {
    const { data: requests } = await supabase
      .from("spin_requests")
      .select("*")
      .eq("from_user_id", userId)
      .order("created_at", { ascending: false });

    const results: (SpinRequest & { profile: Profile })[] = [];
    for (const req of requests || []) {
      const { data: profileData } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", req.to_user_id)
        .maybeSingle();
      if (profileData) {
        results.push({ ...mapSpinRequest(req), profile: mapProfile(profileData) });
      }
    }
    return results;
  }

  async respondToSpinRequest(requestId: string, userId: string, accept: boolean): Promise<SpinRequest | undefined> {
    const { data: reqData } = await supabase
      .from("spin_requests")
      .select("*")
      .eq("id", requestId)
      .eq("to_user_id", userId)
      .maybeSingle();
    if (!reqData || reqData.status !== "pending") return undefined;

    const newStatus = accept ? "accepted" : "declined";
    const { data: updated } = await supabase
      .from("spin_requests")
      .update({ status: newStatus })
      .eq("id", requestId)
      .select()
      .single();
    return updated ? mapSpinRequest(updated) : undefined;
  }

  async getSpinRequest(id: string): Promise<SpinRequest | undefined> {
    const { data } = await supabase
      .from("spin_requests")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    return data ? mapSpinRequest(data) : undefined;
  }

  async setMeetAvailability(matchId: string, userId: string, availability: string): Promise<Match | undefined> {
    const { data: matchData } = await supabase
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return undefined;
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    if ((match.callStage || 0) < 3) return undefined;

    const updates: Record<string, any> = {};
    if (match.user1Id === userId) {
      updates.meet_availability_1 = availability;
    } else {
      updates.meet_availability_2 = availability;
    }

    const { data: updated } = await supabase
      .from("matches")
      .update(updates)
      .eq("id", matchId)
      .select()
      .single();
    return updated ? mapMatch(updated) : undefined;
  }

  async exchangeNumber(matchId: string, userId: string): Promise<Match | undefined> {
    const { data: matchData } = await supabase
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return undefined;
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return undefined;
    if ((match.callStage || 0) < 3) return undefined;
    if (!match.meetAvailability1 || !match.meetAvailability2) return undefined;

    const mySlots: string[] = JSON.parse(match.user1Id === userId ? match.meetAvailability1 : match.meetAvailability2);
    const theirSlots: string[] = JSON.parse(match.user1Id === userId ? match.meetAvailability2 : match.meetAvailability1);
    const hasMatchingSlots = mySlots.some(s => theirSlots.includes(s));
    if (!hasMatchingSlots) return undefined;

    const updates: Record<string, any> = {};
    if (match.user1Id === userId) {
      updates.number_exchanged_1 = true;
    } else {
      updates.number_exchanged_2 = true;
    }

    const { data: updated } = await supabase
      .from("matches")
      .update(updates)
      .eq("id", matchId)
      .select()
      .single();
    return updated ? mapMatch(updated) : undefined;
  }

  async removeMatch(matchId: string, userId: string): Promise<boolean> {
    const { data: matchData } = await supabase
      .from("matches")
      .select("*")
      .eq("id", matchId)
      .maybeSingle();
    if (!matchData) return false;
    const match = mapMatch(matchData);
    if (match.user1Id !== userId && match.user2Id !== userId) return false;

    await supabase
      .from("matches")
      .update({ status: "removed" })
      .eq("id", matchId);
    return true;
  }

  async getMatchCount(userId: string): Promise<number> {
    const { data: activeMatches } = await supabase
      .from("matches")
      .select("*")
      .eq("status", "active")
      .or(`user1_id.eq.${userId},user2_id.eq.${userId}`);

    let count = 0;
    for (const row of activeMatches || []) {
      const match = mapMatch(row);
      const otherUserId = match.user1Id === userId ? match.user2Id : match.user1Id;
      const { data: profileData } = await supabase
        .from("profiles")
        .select("id")
        .eq("user_id", otherUserId)
        .maybeSingle();
      if (profileData) count++;
    }
    return count;
  }

  async getIncomingOpens(userId: string): Promise<(Interaction & { profile: Profile })[]> {
    const { data: userInteractedBack } = await supabase
      .from("interactions")
      .select("to_user_id")
      .eq("from_user_id", userId);
    const interactedBackIds = (userInteractedBack || []).map(r => r.to_user_id);

    const { data: matchRows1 } = await supabase
      .from("matches")
      .select("user1_id")
      .eq("user2_id", userId)
      .eq("status", "active");
    const { data: matchRows2 } = await supabase
      .from("matches")
      .select("user2_id")
      .eq("user1_id", userId)
      .eq("status", "active");
    const matchedIds = [
      ...(matchRows1 || []).map(r => r.user1_id),
      ...(matchRows2 || []).map(r => r.user2_id),
    ];

    const excludeIds = [...new Set([...interactedBackIds, ...matchedIds])];

    let query = supabase
      .from("interactions")
      .select("*")
      .eq("to_user_id", userId)
      .eq("type", "open")
      .order("created_at", { ascending: false });

    if (excludeIds.length > 0) {
      query = query.not("from_user_id", "in", `(${excludeIds.join(",")})`);
    }

    const { data: incomingOpens } = await query;

    const result: (Interaction & { profile: Profile })[] = [];
    for (const open of incomingOpens || []) {
      const { data: profileData } = await supabase
        .from("profiles")
        .select("*")
        .eq("user_id", open.from_user_id)
        .maybeSingle();
      if (profileData) {
        result.push({ ...mapInteraction(open), profile: mapProfile(profileData) });
      }
    }
    return result;
  }
}

export const storage = new SupabaseStorage();
