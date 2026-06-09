# i18n Audit Report

## Objective
Ensure every user-facing string across the Lulou Dating app passes through `t()` from `useLanguageContext`. Dynamic user content (names, typed answers, chat messages, profile-question text) must NOT be translated.

## Files Audited

| File | Status | Notes |
|------|--------|-------|
| `client/src/pages/matches.tsx` | ✅ Complete | All hardcoded UI strings extracted |
| `client/src/pages/onboarding.tsx` | ✅ Complete | All placeholders, button labels, and toast messages extracted |
| `client/src/pages/elevate-success.tsx` | ✅ Complete | "Super Elevate"/"Elevate" labels and visibility text extracted |
| `client/src/pages/intent.tsx` | ✅ Complete | Spin UI, connect button, purchase popup, toast messages extracted |
| `client/src/components/active-call.tsx` | ✅ Complete | Stage labels, timer messages, status labels, permission UI extracted |
| `client/src/components/app-layout.tsx` | ✅ No hardcoded strings found | Navigation labels already use `t()` |
| `client/src/pages/landing.tsx` | ✅ Previously completed | Full audit done in prior session |
| `client/src/pages/profile.tsx` | ✅ Previously completed | Full audit done in prior session |
| `client/src/pages/settings.tsx` | ✅ Previously completed | Full audit done in prior session |
| `client/src/pages/not-found.tsx` | ✅ Previously completed | All strings extracted |
| `client/src/pages/extras-success.tsx` | ✅ Previously completed | All strings extracted |

## Changes Made

### `client/src/lib/i18n.ts`
Added ~100 new keys to the `en` block (other languages fall back to English via `getTranslation`):
- **matches UI**: `decline_label`, `answering_label`, `answer_label`
- **date slot labels**: `day_sun`–`day_sat`, `month_jan`–`month_dec`, `time_morning`, `time_afternoon`, `time_evening`, `time_late_evening`
- **onboarding placeholders**: `ph_custom_starter`, `ph_viewer_question`, `ph_custom_question`, `ph_your_answer`, `ph_custom_signal`, `ph_custom_green_flag`
- **onboarding buttons/toasts**: `add_label`, `creating_profile_label`, `complete_profile_label`, `photo_not_added_title`, `photo_not_added_desc`
- **elevate success**: `super_elevate_label`, `elevate_label`, `boost_started_now`
- **active-call overlay**: `first_call_stage_label`, `second_call_stage_label`, `face_call_stage_label_audio`, `timer_first_completed`, `timer_second_completed`, `timer_completed`, `ringing_label`, `connecting_label`, `starting_camera`, `starting_mic`, `reconnecting_label`, `connected_label`, `mic_camera_needed`, `mic_needed`, `allow_mic_camera`, `allow_mic`, `open_settings_hint`, `tap_to_end`, `ten_sec_remaining`, `two_min_remaining`, `n_min_remaining`
- **call scheduling**: `call_slot_proposed`, `call_accepted_msg`, `call_accepted_waiting`, `first_call_ready`, `second_call_ready`, `propose_time_btn`, `accept_time_btn`, `decline_time_btn`, `propose_title`, `quick_times_title`, `confirm_time_title`, `call_confirmed_other`, `my_time_sent`, `waiting_their_confirmation`, `waiting_their_acceptance`, and many more
- **match toasts**: `first_call_completed_title`, `second_call_completed_title`, face call stage toasts, error toasts
- **chat hints**: `hint_first_call_ready`, `hint_second_call_ready`, `hint_face_call_unlocked`, `hint_post_call_messages`, and related
- **intent wheel**: `wheel_title`, `wheel_desc`, `spin_btn`, `purchase_modal_title`, spin economy descriptions

### `client/src/pages/matches.tsx`
- `RequestCard` component: "Decline" button → `t("decline_label")`
- `generateDateSlots(t)`: refactored to accept `t` as a parameter (cannot use hooks in plain functions); day names, month names, and time-of-day labels all go through `t()`
- `ReadyToMeetInline`: date picker slots now use translated labels
- `_MatchChat`: added `const { t } = useLanguageContext()` (was missing)
- `MatchCard`: added `const { t } = useLanguageContext()` (was missing)
- Inline call overlay: "Decline" → `t("decline_label")`, "Answering…"/"Answer" → `t("answering_label")`/`t("answer_label")`
- All call-lifecycle toasts, stage hints, textarea placeholders, face-call accept/skip UI — all through `t()`

### `client/src/pages/onboarding.tsx`
- `OnboardingPage`: all placeholder strings for custom starters, viewer questions, custom questions, custom signals, custom green flags → `t()` keys
- "Add" button label → `t("add_label")`
- "Creating..."/"Complete Profile" button → `t("creating_profile_label")`/`t("complete_profile_label")`
- `PhotoSlot`: added `const { t } = useLanguageContext()`; photo error toast → `t("photo_not_added_title")`/`t("photo_not_added_desc")`

### `client/src/pages/elevate-success.tsx`
- `LiveStatusCard`: "Super Elevate"/"Elevate" → `t("super_elevate_label")`/`t("elevate_label")`
- `ElevateSuccessPage` header: type label → `t()`
- Boost detail line: `"{dur} min · {mult} visibility · Started now"` → `t("boost_started_now")` with `.replace()` substitutions

### `client/src/components/active-call.tsx`
- `stageLabel`: all three stages → `t()` keys
- Timer-expiry `useEffect`: completion messages → `t()` keys; renamed `const t = setTimeout` → `const tid` to eliminate variable shadowing
- Second `useEffect`: renamed `const t = setTimeout` → `const tid2`
- `statusLabel` IIFE: all connection state strings → `t()` keys
- Permission-denied screen: title, body text, settings hint, "Tap to end call" → `t()` keys
- Time-remaining hint: all warning labels → `t()` keys with `{n}` substitution

## Strings Intentionally NOT Translated

The following are dynamic user content and must stay as-is:
- Profile `firstName`, `age`, `datingIntent`, `location`, `height`
- Chat message `content`
- Conversation starter text (user-typed answers)
- Profile question answers
- `match.profile.datingIntent` shown as a preview in match list

## TypeScript Status (`npx tsc --noEmit`)

Errors introduced by this i18n work: **0**

Pre-existing errors (present before this task, unrelated to i18n):
- `active-call.tsx(935)` — implicit `any` in memo callback (pre-existing)
- `i18n.ts(30)` — `Set<string>` assignability (pre-existing)
- `matches.tsx(909, 1142, 1917)` — type mismatches in ProfilePhotoViewer and optimistic message (pre-existing)
- `onboarding.tsx(903)` — `STEPS` constant was removed in a prior session (pre-existing)
