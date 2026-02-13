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
    conversationStarters: ["The way to my heart is... a spontaneous road trip", "A perfect Sunday looks like... farmers market then cooking together", "I light up when I talk about... design and creativity"],
    questions: ["What's a small thing that makes your day better?", "What does a meaningful relationship look like to you?", "How do you recharge after a long week?"],
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
    conversationStarters: ["I'm proudest of... learning to cook my grandmother's recipes", "Something most people don't know about me... I play jazz piano", "My love language is... quality time"],
    questions: ["What's one thing you're learning right now?", "What kind of conversations do you enjoy most?", "What's a goal you're working toward?"],
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
    conversationStarters: ["A perfect Sunday looks like... hiking with a good podcast", "The way to my heart is... making me laugh until I cry", "I light up when I talk about... travel stories"],
    questions: ["How do you recharge after a long week?", "What's a small thing that makes your day better?", "What kind of conversations do you enjoy most?"],
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
    conversationStarters: ["Something most people don't know about me... I restore vintage furniture", "My love language is... acts of service", "I'm proudest of... building my own business"],
    questions: ["What's one thing you're learning right now?", "What does a meaningful relationship look like to you?", "What's a goal you're working toward?"],
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
    conversationStarters: ["The way to my heart is... thoughtful handwritten notes", "A perfect Sunday looks like... bookshop browsing and cozy cafes", "I light up when I talk about... psychology and human connection"],
    questions: ["What does a meaningful relationship look like to you?", "What's a small thing that makes your day better?", "What's one thing you're learning right now?"],
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
