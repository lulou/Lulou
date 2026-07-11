import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp, index, doublePrecision, json, primaryKey } from "drizzle-orm/pg-core";
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

export const BENEFIT_TYPES = ["message_extension", "extra_call", "video_call", "voice_notes_unlock", "undo_close"] as const;
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

export const processedStripeSessions = pgTable("processed_stripe_sessions", {
  sessionId: varchar("session_id").primaryKey(),
  userId: varchar("user_id").notNull(),
  itemRef: text("item_ref").notNull().default(""),
  grantedAt: timestamp("granted_at").defaultNow(),
});

// ── Refund Records ────────────────────────────────────────────────────────────
// One row per Stripe refund event. Provides in-app payment history + unread badge.
// readAt = null means the user has not yet acknowledged this refund notification.
export const refundRecords = pgTable("refund_records", {
  id:              varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId:          varchar("user_id").notNull(),
  refundId:        varchar("refund_id").notNull().unique(),
  amountCents:     integer("amount_cents").notNull(),
  currency:        text("currency").notNull().default("aud"),
  amountFormatted: text("amount_formatted").notNull(),
  productName:     text("product_name").notNull(),
  status:          text("status").notNull().default("completed"),
  readAt:          timestamp("read_at"),
  createdAt:       timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_refund_records_user").on(table.userId),
]);
export type RefundRecord = typeof refundRecords.$inferSelect;

// Persists purchased Spark credits (spin credits bought via Stripe).
// One row per user — balance is incremented on purchase and decremented on use.
export const sparkBalances = pgTable("spark_balances", {
  userId: varchar("user_id").primaryKey(),
  balance: integer("balance").notNull().default(0),
  updatedAt: timestamp("updated_at").defaultNow(),
});
export type SparkBalance = typeof sparkBalances.$inferSelect;

// Audit trail for Spark pack purchases.
export const sparkPurchases = pgTable("spark_purchases", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: varchar("user_id").notNull(),
  packType: text("pack_type").notNull(),
  quantity: integer("quantity").notNull(),
  stripeSessionId: varchar("stripe_session_id").notNull().unique(),
  purchasedAt: timestamp("purchased_at").defaultNow(),
}, (table) => [
  index("idx_spark_purchases_user").on(table.userId),
]);

// Tracks active/cancelled membership subscriptions.
// userId is the PK — one subscription record per user.
// stripeCustomerId enables the webhook → user lookup on monthly renewal.
export const membershipSubscriptions = pgTable("membership_subscriptions", {
  userId: varchar("user_id").primaryKey(),
  stripeCustomerId: varchar("stripe_customer_id").notNull(),
  stripeSubscriptionId: varchar("stripe_subscription_id").notNull(),
  status: text("status").notNull().default("active"), // 'active' | 'cancelled'
  currentPeriodEnd: timestamp("current_period_end"),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});
export type MembershipSubscription = typeof membershipSubscriptions.$inferSelect;

export const activeSessions = pgTable("active_sessions", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId: text("user_id").notNull().unique(),
  sessionId: text("session_id").notNull(),
  deviceId: text("device_id").notNull().default(""),
  userAgent: text("user_agent").notNull().default(""),
  createdAt: timestamp("created_at").defaultNow(),
  lastSeenAt: timestamp("last_seen_at").defaultNow(),
  expiresAt: timestamp("expires_at").notNull(),
}, (table) => [
  index("idx_active_sessions_user").on(table.userId),
]);

// ── Push Notification Subscriptions ──────────────────────────────────────────
export const pushSubscriptions = pgTable("push_subscriptions", {
  id:          varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  userId:      text("user_id").notNull(),
  endpoint:    text("endpoint").notNull().unique(),
  p256dh:      text("p256dh").notNull(),
  auth:        text("auth").notNull(),
  userAgent:   text("user_agent").default(""),
  failCount:   integer("fail_count").default(0),
  createdAt:   timestamp("created_at").defaultNow(),
  lastUsedAt:  timestamp("last_used_at").defaultNow(),
}, (table) => [
  index("idx_push_subs_user").on(table.userId),
]);

// ── Notification Preferences (per user, per category) ─────────────────────────
export const notificationPreferences = pgTable("notification_preferences", {
  userId:       text("user_id").primaryKey(),
  newLike:      boolean("new_like").default(true),
  newMatch:     boolean("new_match").default(true),
  newMessage:   boolean("new_message").default(true),
  incomingCall: boolean("incoming_call").default(true),
  missedCall:   boolean("missed_call").default(true),
  halo:         boolean("halo").default(true),
  elevate:      boolean("elevate").default(true),
  payment:      boolean("payment").default(true),
  safety:       boolean("safety").default(true),
  updatedAt:    timestamp("updated_at").defaultNow(),
});

export type PushSubscription     = typeof pushSubscriptions.$inferSelect;
export type NotificationPrefs    = typeof notificationPreferences.$inferSelect;

// ── Active Chat Sessions (push suppression for same-chat recipients) ──────────
// One row per user — tracks the matchId they are currently viewing.
// lastSeenAt is updated every 20 s by client heartbeat.
// Push notifications are suppressed if lastSeenAt < 45 s ago and matchId matches.
export const activeChatSessions = pgTable("active_chat_sessions", {
  userId:     text("user_id").primaryKey(),
  matchId:    text("match_id").notNull(),
  lastSeenAt: timestamp("last_seen_at").defaultNow().notNull(),
});

export type UserBenefit = typeof userBenefits.$inferSelect;
export type ActiveChatSession = typeof activeChatSessions.$inferSelect;
export type ActiveSession = typeof activeSessions.$inferSelect;
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
  "Committed Relationship",
  "Serious Dating",
  "Open To Connection",
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

// ── Admin Payment Simulations ─────────────────────────────────────────────────
// Stores records of admin-triggered test purchase and refund simulations.
// IDs use sim_session_ / sim_refund_ prefixes — never mixed with real Stripe IDs.

export const adminPaymentSimulations = pgTable("admin_payment_simulations", {
  id:                 varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  simSessionId:       varchar("sim_session_id").notNull().unique(),
  adminUserId:        varchar("admin_user_id").notNull(),
  targetUserId:       varchar("target_user_id").notNull(),
  itemId:             text("item_id"),
  packId:             text("pack_id"),
  productName:        text("product_name").notNull(),
  amountCents:        integer("amount_cents").notNull().default(0),
  currency:           text("currency").notNull().default("aud"),
  status:             text("status").notNull().default("granted"),
  refundSimId:        varchar("refund_sim_id"),
  grantResult:        text("grant_result"),
  purchaseEmailSent:  boolean("purchase_email_sent").notNull().default(false),
  refundEmailSent:    boolean("refund_email_sent").notNull().default(false),
  errorLog:           text("error_log"),
  createdAt:          timestamp("created_at").defaultNow(),
  refundedAt:         timestamp("refunded_at"),
}, (table) => [
  index("idx_admin_sim_target").on(table.targetUserId),
  index("idx_admin_sim_admin").on(table.adminUserId),
]);
export type AdminPaymentSimulation = typeof adminPaymentSimulations.$inferSelect;

// ── Date-plan 24h reminder dedup ─────────────────────────────────────────────
// Prevents the cron from sending the same reminder twice across server restarts.
export const datePlanRemindersSent = pgTable("date_plan_reminders_sent", {
  matchId:      varchar("match_id").notNull(),
  reminderType: text("reminder_type").notNull(),  // e.g. "24h"
  sentAt:       timestamp("sent_at").defaultNow().notNull(),
}, (table) => [
  primaryKey({ columns: [table.matchId, table.reminderType] }),
]);

// ── Per-user per-match badge counts ───────────────────────────────────────────
// Tracks how many unread push-triggered messages each user has per match.
// Incremented when a push notification is sent; reset when the user reads the chat.
// Used to supply the correct cumulative badgeCount to the iOS Home Screen icon.
export const userMatchBadgeCounts = pgTable("user_match_badge_counts", {
  userId:  varchar("user_id").notNull(),
  matchId: varchar("match_id").notNull(),
  count:   integer("count").notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.userId, table.matchId] }),
  index("idx_badge_counts_user").on(table.userId),
]);
