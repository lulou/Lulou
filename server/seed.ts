import { db } from "./db";
import { profiles } from "@shared/schema";
import { sql } from "drizzle-orm";

const SEED_PROFILES = [
  {
    userId: "seed-user-1",
    firstName: "Maya",
    age: 28,
    gender: "woman",
    datingPreference: "men",
    location: "San Francisco, CA",
    height: "5'6\"",
    photos: ["/images/profile-1.png", "/images/profile-3.png", "/images/profile-5.png"],
    signals: ["Emotionally Available", "Playful", "Growth Minded"],
    datingIntent: "Meaningful Relationship",
    greenFlags: ["Communicates Clearly", "Emotionally Consistent", "Kind & Caring"],
    connectionStyle: "Steady with Momentum",
    onboardingComplete: true,
  },
  {
    userId: "seed-user-2",
    firstName: "James",
    age: 31,
    gender: "man",
    datingPreference: "women",
    location: "Oakland, CA",
    height: "6'1\"",
    photos: ["/images/profile-2.png", "/images/profile-4.png"],
    signals: ["Calm Communicator", "Romantic", "Thoughtful"],
    datingIntent: "Meaningful Relationship",
    greenFlags: ["Keeps Their Word", "Great Listener", "Shows Up Fully"],
    connectionStyle: "Slow & Intentional",
    onboardingComplete: true,
  },
  {
    userId: "seed-user-3",
    firstName: "Priya",
    age: 26,
    gender: "woman",
    datingPreference: "men",
    location: "Berkeley, CA",
    height: "5'4\"",
    photos: ["/images/profile-3.png", "/images/profile-1.png", "/images/profile-5.png"],
    signals: ["Adventurous", "Compassionate", "Witty"],
    datingIntent: "Intentional Dating",
    greenFlags: ["Communicates Clearly", "Genuinely Curious", "Respects Boundaries"],
    connectionStyle: "Ready to Meet Soon",
    onboardingComplete: true,
  },
  {
    userId: "seed-user-4",
    firstName: "Ethan",
    age: 29,
    gender: "man",
    datingPreference: "women",
    location: "San Jose, CA",
    height: "5'11\"",
    photos: ["/images/profile-4.png", "/images/profile-2.png"],
    signals: ["Affectionate", "Grounded", "Creative"],
    datingIntent: "Open but Serious",
    greenFlags: ["Emotionally Consistent", "Kind & Caring", "Shows Up Fully"],
    connectionStyle: "Steady with Momentum",
    onboardingComplete: true,
  },
  {
    userId: "seed-user-5",
    firstName: "Sophie",
    age: 30,
    gender: "woman",
    datingPreference: "everyone",
    location: "Palo Alto, CA",
    height: "5'7\"",
    photos: ["/images/profile-5.png", "/images/profile-1.png", "/images/profile-3.png"],
    signals: ["Romantic", "Thoughtful", "Emotionally Available", "Growth Minded"],
    datingIntent: "Meaningful Relationship",
    greenFlags: ["Great Listener", "Communicates Clearly", "Keeps Their Word", "Kind & Caring"],
    connectionStyle: "Slow & Intentional",
    onboardingComplete: true,
  },
];

export async function seedDatabase() {
  try {
    const existing = await db.select({ count: sql<number>`count(*)::int` }).from(profiles);
    if (existing[0].count > 0) {
      console.log("Database already has profiles, skipping seed");
      return;
    }

    for (const profile of SEED_PROFILES) {
      await db.insert(profiles).values(profile);
    }

    console.log(`Seeded ${SEED_PROFILES.length} profiles`);
  } catch (error) {
    console.error("Error seeding database:", error);
  }
}
