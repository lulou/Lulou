import { supabase } from "./supabase";

const FIELD_MAP: Record<string, string> = {
  firstName: "first_name",
  age: "age",
  gender: "gender",
  datingPreference: "dating_preference",
  location: "location",
  height: "height",
  photos: "photos",
  signals: "signals",
  datingIntent: "dating_intent",
  greenFlags: "green_flags",
  connectionStyle: "connection_style",
  conversationStarters: "conversation_starters",
  questions: "questions",
  locationRadius: "location_radius",
  preferredAgeMin: "preferred_age_min",
  preferredAgeMax: "preferred_age_max",
  email: "email",
  phoneNumber: "phone_number",
  photoVerified: "photo_verified",
  onboardingComplete: "onboarding_complete",
};

function toDbFields(fields: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const dbKey = FIELD_MAP[key];
    if (dbKey) row[dbKey] = value;
  }
  return row;
}

export async function upsertProfile(fields: Record<string, unknown>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    throw new Error("Session expired. Please sign in again.");
  }

  const dbFields = toDbFields(fields);
  const payload = { ...dbFields, user_id: user.id };

  console.log("PROFILE_UPSERT user.id:", user.id, "payload keys:", Object.keys(payload));

  const { data, error } = await supabase
    .from("profiles")
    .upsert(payload, { onConflict: "user_id" })
    .select()
    .single();

  if (error) {
    console.error("PROFILE_UPSERT_ERROR", error.message);
    throw new Error(error.message);
  }
  return data;
}

export async function initProfileOnLogin() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const { data: existing, error: existErr } = await supabase
    .from("profiles")
    .select("id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (existErr) {
    console.error("PROFILE_CHECK_ERROR", existErr.code, existErr.message, existErr.details);
    throw new Error(`Profile check failed: ${existErr.message} (${existErr.code})`);
  }

  if (existing) {
    console.log("PROFILE_INIT_SKIPPED - profile already exists for:", user.id);
    return;
  }

  const payload = {
    user_id: user.id,
    first_name: user.user_metadata?.first_name || user.email?.split("@")[0] || "New User",
    age: 25,
    gender: "Prefer not to say",
    dating_preference: "Everyone",
    location: "Not set",
    photos: [] as string[],
    signals: [] as string[],
    dating_intent: "Not set",
    green_flags: [] as string[],
    connection_style: "Not set",
    conversation_starters: [] as string[],
    questions: [] as string[],
    onboarding_complete: false,
    email: user.email || "",
  };

  console.log("PROFILE_INIT_INSERT user.id:", user.id, "payload keys:", Object.keys(payload));

  const { data, error } = await supabase
    .from("profiles")
    .upsert(payload, { onConflict: "user_id" })
    .select()
    .single();

  if (error) {
    console.error("PROFILE_INIT_UPSERT_ERROR", error.code, error.message, error.details, error.hint);
    throw new Error(`Profile creation failed: ${error.message} (${error.code})${error.hint ? " — " + error.hint : ""}`);
  }

  console.log("PROFILE_INIT_SUCCESS", { userId: user.id, profileId: data?.id });
  return data;
}
