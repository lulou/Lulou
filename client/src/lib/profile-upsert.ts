import { supabase } from "./supabase";
import { apiRequest } from "./queryClient";

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

export async function initProfileOnLogin(accessToken: string) {
  console.log("PROFILE_INIT_CALLING_SERVER with explicit token");

  const res = await fetch("/api/auth/init", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    credentials: "include",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    let msg = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.message) msg = parsed.message;
    } catch {}
    console.error("PROFILE_INIT_SERVER_ERROR", res.status, msg);
    throw new Error(`Profile creation failed: ${msg}`);
  }

  console.log("PROFILE_INIT_SERVER_SUCCESS");
}
