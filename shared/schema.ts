import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp, index, doublePrecision, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export * from "./models/auth";

export const profiles = pgTable("profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().unique(),
  firstName: text("first_name").notNull(),
  age: integer("age").notNull(),
  gender: text("gender").notNull(),
  datingPreference: text("dating_preference").notNull(),
  location: text("location").notNull(),
  height: text("height"),
  photos: text("photos").array().notNull(),
  signals: text("signals").array().notNull(),
  datingIntent: text("dating_intent").notNull(),
  greenFlags: text("green_flags").array().notNull(),
  connectionStyle: text("connection_style").notNull(),
  conversationStarters: text("conversation_starters").array(),
  questions: text("questions").array(),
  customQuestions: json("custom_questions").$type<Array<{ question: string; answer: string }>>(),
  viewerQuestions: json("viewer_questions").$type<Array<{ question: string }>>(),
  customStarters: json("custom_starters").$type<string[]>(),
  dateOfBirth: text("date_of_birth"),
  pronouns: text("pronouns"),
  customGreenFlags: json("custom_green_flags").$type<string[]>(),
  customSignals: json("custom_signals").$type<string[]>(),
  locationRadius: integer("location_radius").default(25),
  latitude: doublePrecision("latitude"),
  longitude: doublePrecision("longitude"),
  preferredAgeMin: integer("preferred_age_min").default(18),
  preferredAgeMax: integer("preferred_age_max").default(45),
  email: text("email"),
  phoneNumber: text("phone_number"),
  photoVerified: boolean("photo_verified").default(false),
  onboardingComplete: boolean("onboarding_complete").default(false),
  isPaused: boolean("is_paused").default(false),
  elevateType: text("elevate_type"),
  elevateExpiresAt: timestamp("elevate_expires_at"),
  lastActive: timestamp("last_active"),
  showLastActive: boolean("show_last_active").default(true),
  commentFilter: boolean("comment_filter").default(true),
  conversationStarterAi: boolean("conversation_starter_ai").default(true),
  createdAt: timestamp("created_at").defaultNow(),
});

export const interactions = pgTable("interactions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fromUserId: varchar("from_user_id").notNull(),
  toUserId: varchar("to_user_id").notNull(),
  type: text("type").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_interactions_from").on(table.fromUserId),
  index("idx_interactions_to").on(table.toUserId),
]);

export const matches = pgTable("matches", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  user1Id: varchar("user1_id").notNull(),
  user2Id: varchar("user2_id").notNull(),
  messageCount1: integer("message_count_1").default(0),
  messageCount2: integer("message_count_2").default(0),
  callCompleted: boolean("call_completed").default(false),
  callStartedAt: timestamp("call_started_at"),
  callAnswered: boolean("call_answered").default(false),
  callInitiatorId: varchar("call_initiator_id"),
  callStage: integer("call_stage").default(0),
  callSessionId: varchar("call_session_id"),
  faceCallUser1Accepted: boolean("face_call_user1_accepted").default(false),
  faceCallUser2Accepted: boolean("face_call_user2_accepted").default(false),
  meetAvailability1: text("meet_availability_1"),
  meetAvailability2: text("meet_availability_2"),
  numberExchanged1: boolean("number_exchanged_1").default(false),
  numberExchanged2: boolean("number_exchanged_2").default(false),
  dateChoiceUser1: text("date_choice_user1"),
  dateChoiceUser2: text("date_choice_user2"),
  status: text("status").default("active"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_matches_user1_id").on(table.user1Id),
  index("idx_matches_user2_id").on(table.user2Id),
]);

export const messages = pgTable("messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  matchId: varchar("match_id").notNull(),
  senderId: varchar("sender_id").notNull(),
  content: text("content").notNull(),
  reaction: varchar("reaction"),
  voiceTranscript: text("voice_transcript"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_messages_match").on(table.matchId),
  index("idx_messages_match_created").on(table.matchId, table.createdAt),
]);

export const insertProfileSchema = createInsertSchema(profiles).omit({
  id: true,
  createdAt: true,
});

export const insertInteractionSchema = createInsertSchema(interactions).omit({
  id: true,
  createdAt: true,
});

export const spinStandouts = pgTable("spin_standouts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  standoutUserId: varchar("standout_user_id").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_spin_standouts_user").on(table.userId),
]);

export const spinUsage = pgTable("spin_usage", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  spinDate: text("spin_date").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_spin_usage_user").on(table.userId),
]);

export const spinRequests = pgTable("spin_requests", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  fromUserId: varchar("from_user_id").notNull(),
  toUserId: varchar("to_user_id").notNull(),
  message: text("message").notNull(),
  status: text("status").notNull().default("pending"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_spin_requests_from").on(table.fromUserId),
  index("idx_spin_requests_to").on(table.toUserId),
]);

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});

export const BENEFIT_TYPES = ["message_extension", "extra_call", "video_call", "voice_notes_unlock"] as const;
export type BenefitType = typeof BENEFIT_TYPES[number];

export const userBenefits = pgTable("user_benefits", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  type: text("type").notNull(),
  activatedMatchId: varchar("activated_match_id"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_user_benefits_user").on(table.userId),
]);

export const userElevates = pgTable("user_elevates", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().unique(),
  elevateType: text("elevate_type").notNull().default("elevate"),
  expiresAt: timestamp("expires_at").notNull().default(sql`now()`),
  activatedAt: timestamp("activated_at"),
  elevateCredits: integer("elevate_credits").notNull().default(0),
  superElevateCredits: integer("super_elevate_credits").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_user_elevates_user").on(table.userId),
]);

export const callCredits = pgTable("call_credits", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().unique(),
  phoneCredits: integer("phone_credits").notNull().default(0),
  videoCredits: integer("video_credits").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
}, (table) => [
  index("idx_call_credits_user").on(table.userId),
]);

export const savedWheelProfiles = pgTable("saved_wheel_profiles", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull().unique(),
  savedProfileId: varchar("saved_profile_id").notNull(),
  savedAt: timestamp("saved_at").notNull().defaultNow(),
  expiresAt: timestamp("expires_at"),
}, (table) => [
  index("idx_saved_wheel_user").on(table.userId),
]);

export const blockedContacts = pgTable("blocked_contacts", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  name: text("name").notNull().default(""),
  phoneNumber: text("phone_number").notNull().default(""),
  email: text("email"),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_blocked_contacts_user").on(table.userId),
]);

export type UserBenefit = typeof userBenefits.$inferSelect;
export type UserElevate = typeof userElevates.$inferSelect;
export type BlockedContact = typeof blockedContacts.$inferSelect;
export type CallCredit = typeof callCredits.$inferSelect;
export type SavedWheelProfile = typeof savedWheelProfiles.$inferSelect;

export type Profile = typeof profiles.$inferSelect;
export type InsertProfile = z.infer<typeof insertProfileSchema>;
export type Interaction = typeof interactions.$inferSelect;
export type InsertInteraction = z.infer<typeof insertInteractionSchema>;
export type Match = typeof matches.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;
export type SpinRequest = typeof spinRequests.$inferSelect;

export const SIGNALS = [
  "Emotionally Available",
  "Playful",
  "Calm Communicator",
  "Affectionate",
  "Growth Minded",
  "Romantic",
  "Adventurous",
  "Thoughtful",
  "Witty",
  "Compassionate",
  "Creative",
  "Grounded",
] as const;

export const GREEN_FLAGS = [
  "Communicates Clearly",
  "Emotionally Consistent",
  "Keeps Their Word",
  "Kind & Caring",
  "Great Listener",
  "Shows Up Fully",
  "Respects Boundaries",
  "Genuinely Curious",
] as const;

export const DATING_INTENTS = [
  "Meaningful Relationship",
  "Intentional Dating",
  "Open but Serious",
] as const;

export const CONNECTION_STYLES = [
  "Slow & Intentional",
  "Steady with Momentum",
  "Ready to Meet Soon",
] as const;

export const CONVERSATION_STARTERS = [
  "The way to my heart is...",
  "A perfect Sunday looks like...",
  "I'm proudest of...",
  "Something most people don't know about me...",
  "I light up when I talk about...",
  "My love language is...",
  "A spontaneous thing I've done recently...",
  "The soundtrack of my life would be...",
  "I feel most alive when...",
  "My comfort food after a long day is...",
  "A place I keep coming back to...",
  "The best advice I've ever received...",
  "I knew I'd found my people when...",
  "My idea of romance is...",
  "Something I could talk about for hours...",
  "The last thing that genuinely surprised me...",
  "A tradition I'd love to start with someone...",
  "I'm secretly really good at...",
  "What makes me laugh the hardest...",
  "The moment I felt most grateful...",
] as const;

export const PROFILE_QUESTIONS = [
  "What's one thing you're learning right now?",
  "What does a meaningful relationship look like to you?",
  "What's a small thing that makes your day better?",
  "How do you recharge after a long week?",
  "What's a goal you're working toward?",
  "What kind of conversations do you enjoy most?",
  "What does trust look like to you in a relationship?",
  "What's a book, film, or song that changed your perspective?",
  "What would your closest friend say is your best quality?",
  "How do you handle disagreements with someone you care about?",
  "What does your ideal weeknight look like?",
  "What's a value you'd never compromise on?",
  "What are you most curious about right now?",
  "How do you show someone you care?",
  "What's an experience that shaped who you are today?",
  "What does personal growth mean to you?",
  "What kind of support do you value most from a partner?",
  "What's something you want to do more of this year?",
  "What does being present with someone look like to you?",
  "What's the bravest thing you've ever done?",
] as const;
