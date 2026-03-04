import { supabase } from "./supabase";

function buildDbRow(userId: string, fields: Record<string, unknown>): Record<string, unknown> {
  const dbRow: Record<string, unknown> = { id: userId, user_id: userId };
  if (fields.firstName !== undefined) dbRow.first_name = fields.firstName;
  if (fields.age !== undefined) dbRow.age = fields.age;
  if (fields.gender !== undefined) dbRow.gender = fields.gender;
  if (fields.datingPreference !== undefined) dbRow.dating_preference = fields.datingPreference;
  if (fields.location !== undefined) dbRow.location = fields.location;
  if (fields.height !== undefined) dbRow.height = fields.height;
  if (fields.photos !== undefined) dbRow.photos = fields.photos;
  if (fields.signals !== undefined) dbRow.signals = fields.signals;
  if (fields.datingIntent !== undefined) dbRow.dating_intent = fields.datingIntent;
  if (fields.greenFlags !== undefined) dbRow.green_flags = fields.greenFlags;
  if (fields.connectionStyle !== undefined) dbRow.connection_style = fields.connectionStyle;
  if (fields.conversationStarters !== undefined) dbRow.conversation_starters = fields.conversationStarters;
  if (fields.questions !== undefined) dbRow.questions = fields.questions;
  if (fields.locationRadius !== undefined) dbRow.location_radius = fields.locationRadius;
  if (fields.preferredAgeMin !== undefined) dbRow.preferred_age_min = fields.preferredAgeMin;
  if (fields.preferredAgeMax !== undefined) dbRow.preferred_age_max = fields.preferredAgeMax;
  if (fields.email !== undefined) dbRow.email = fields.email;
  if (fields.phoneNumber !== undefined) dbRow.phone_number = fields.phoneNumber;
  if (fields.photoVerified !== undefined) dbRow.photo_verified = fields.photoVerified;
  if (fields.onboardingComplete !== undefined) dbRow.onboarding_complete = fields.onboardingComplete;
  return dbRow;
}

export async function upsertProfile(fields: Record<string, unknown>) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    window.location.href = "/";
    throw new Error("Not authenticated");
  }

  const { data: legacy } = await supabase
    .from("profiles")
    .select("id")
    .eq("user_id", user.id)
    .neq("id", user.id)
    .maybeSingle();

  if (legacy) {
    await supabase.from("profiles").delete().eq("id", legacy.id);
  }

  const dbRow = buildDbRow(user.id, fields);

  const { data, error } = await supabase
    .from("profiles")
    .upsert(dbRow, { onConflict: "id" })
    .select()
    .single();

  if (error) throw new Error(error.message);
  return data;
}

export async function initProfileOnLogin() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const { data: existing } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", user.id)
    .maybeSingle();

  if (existing) return;

  const { data: legacy } = await supabase
    .from("profiles")
    .select("id")
    .eq("user_id", user.id)
    .neq("id", user.id)
    .maybeSingle();

  if (legacy) {
    await supabase
      .from("profiles")
      .update({ id: user.id })
      .eq("id", legacy.id);
    return;
  }

  const { error } = await supabase
    .from("profiles")
    .upsert({
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
    }, { onConflict: "id" });

  if (error) {
    console.error("PROFILE_INIT_ERROR", error.message);
  }
}
