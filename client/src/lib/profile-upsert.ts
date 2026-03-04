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

  try {
    const { data: legacy, error: legacyErr } = await supabase
      .from("profiles")
      .select("id")
      .eq("user_id", user.id)
      .neq("id", user.id)
      .maybeSingle();

    if (legacyErr) {
      console.error("PROFILE_UPSERT_LEGACY_CHECK_ERROR", legacyErr.message);
    }

    if (legacy) {
      const { error: delErr } = await supabase.from("profiles").delete().eq("id", legacy.id);
      if (delErr) console.error("PROFILE_UPSERT_LEGACY_DELETE_ERROR", delErr.message);
    }
  } catch (err: any) {
    console.error("PROFILE_UPSERT_LEGACY_CLEANUP_ERROR", err?.message || err);
  }

  const dbFields = toDbFields(fields);
  const payload = { ...dbFields, id: user.id, user_id: user.id };

  console.log("PROFILE_UPSERT user.id:", user.id, "payload keys:", Object.keys(payload));

  const { data, error } = await supabase
    .from("profiles")
    .upsert(payload, { onConflict: "id" })
    .select()
    .single();

  if (error) {
    console.error("PROFILE_UPSERT_ERROR", error.message);
    throw new Error(error.message);
  }
  return data;
}

export async function initProfileOnLogin() {
  try {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { data: existing, error: existErr } = await supabase
      .from("profiles")
      .select("id")
      .eq("id", user.id)
      .maybeSingle();

    if (existErr) {
      console.error("PROFILE_CHECK_ERROR", existErr.message);
    }

    if (existing) return;

    const { data: legacy, error: legacyErr } = await supabase
      .from("profiles")
      .select("id")
      .eq("user_id", user.id)
      .neq("id", user.id)
      .maybeSingle();

    if (legacyErr) {
      console.error("PROFILE_LEGACY_CHECK_ERROR", legacyErr.message);
    }

    if (legacy) {
      const { error: updateErr } = await supabase
        .from("profiles")
        .update({ id: user.id })
        .eq("id", legacy.id);
      if (updateErr) console.error("PROFILE_LEGACY_MIGRATE_ERROR", updateErr.message);
      return;
    }

    const payload = {
      id: user.id,
      user_id: user.id,
      first_name: "",
      age: 0,
      gender: "",
      dating_preference: "",
      location: "",
      photos: [],
      signals: [],
      dating_intent: "",
      green_flags: [],
      connection_style: "",
      conversation_starters: [],
      questions: [],
      onboarding_complete: false,
      email: user.email || "",
    };

    console.log("PROFILE_INIT user.id:", user.id, "payload keys:", Object.keys(payload));

    const { error } = await supabase
      .from("profiles")
      .upsert(payload, { onConflict: "id" });

    if (error) {
      console.error("PROFILE_INIT_UPSERT_ERROR", error.message);
    }
  } catch (err: any) {
    console.error("PROFILE_INIT_UNEXPECTED_ERROR", err?.message || err);
  }
}
