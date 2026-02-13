import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, integer, boolean, timestamp, index } from "drizzle-orm/pg-core";
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
  onboardingComplete: boolean("onboarding_complete").default(false),
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
  status: text("status").default("active"),
  createdAt: timestamp("created_at").defaultNow(),
});

export const messages = pgTable("messages", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  matchId: varchar("match_id").notNull(),
  senderId: varchar("sender_id").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
}, (table) => [
  index("idx_messages_match").on(table.matchId),
]);

export const insertProfileSchema = createInsertSchema(profiles).omit({
  id: true,
  createdAt: true,
});

export const insertInteractionSchema = createInsertSchema(interactions).omit({
  id: true,
  createdAt: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});

export type Profile = typeof profiles.$inferSelect;
export type InsertProfile = z.infer<typeof insertProfileSchema>;
export type Interaction = typeof interactions.$inferSelect;
export type InsertInteraction = z.infer<typeof insertInteractionSchema>;
export type Match = typeof matches.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

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
] as const;

export const PROFILE_QUESTIONS = [
  "What's one thing you're learning right now?",
  "What does a meaningful relationship look like to you?",
  "What's a small thing that makes your day better?",
  "How do you recharge after a long week?",
  "What's a goal you're working toward?",
  "What kind of conversations do you enjoy most?",
] as const;
