# i18n Audit Report

## Objective
Ensure every user-facing string across the Lulou Dating app passes through `t()` from `useLanguageContext`. Dynamic user content (names, typed answers, chat messages, profile-question text) must NOT be translated.

## Files Audited

| File | Status | Notes |
|------|--------|-------|
| `client/src/pages/matches.tsx` | ✅ Complete | All hardcoded UI strings extracted |
| `client/src/pages/onboarding.tsx` | ✅ Complete | All placeholders, button labels, and toast messages extracted; `STEPS` replaced with `STEP_KEYS` |
| `client/src/pages/elevate-success.tsx` | ✅ Complete | "Super Elevate"/"Elevate" labels and visibility text extracted |
| `client/src/pages/intent.tsx` | ✅ Complete | Spin UI, connect button, purchase popup, toast messages extracted |
| `client/src/components/active-call.tsx` | ✅ Complete | Stage labels, timer messages, status labels, permission UI, time-remaining hints extracted |
| `client/src/components/app-layout.tsx` | ✅ No hardcoded strings found | Navigation labels already use `t()` |
| `client/src/pages/landing.tsx` | ✅ Previously completed | Full audit done in prior session |
| `client/src/pages/profile.tsx` | ✅ Previously completed | Full audit done in prior session |
| `client/src/pages/settings.tsx` | ✅ Previously completed | Full audit done in prior session |
| `client/src/pages/not-found.tsx` | ✅ Previously completed | All strings extracted |
| `client/src/pages/extras-success.tsx` | ✅ Previously completed | All strings extracted |

## Changes Made

### `client/src/lib/i18n.ts`
Added ~100 new keys to the `en` block (other languages fall back to English via `getTranslation`):
- **matches UI**: `decline_label`, `answering_label`, `answer_label`, `now_matched_desc`, `passed_on_desc`, `phone_sent_as_message`
- **date slot labels**: `day_sun`–`day_sat`, `month_jan`–`month_dec`, `time_morning`, `time_afternoon`, `time_evening`, `time_late_evening`
- **onboarding placeholders**: `ph_custom_starter`, `ph_viewer_question`, `ph_custom_question`, `ph_your_answer`, `ph_custom_signal`, `ph_custom_green_flag`
- **onboarding buttons/toasts**: `add_label`, `creating_profile_label`, `complete_profile_label`, `photo_not_added_title`, `photo_not_added_desc`
- **elevate success**: `super_elevate_label`, `elevate_label`, `boost_started_now`
- **active-call overlay**: `first_call_stage_label`, `second_call_stage_label`, `face_call_stage_label_audio`, `timer_first_completed`, `timer_second_completed`, `timer_completed`, `ringing_label`, `connecting_label`, `starting_camera`, `starting_mic`, `reconnecting_label`, `connected_label`, `mic_camera_needed`, `mic_needed`, `allow_mic_camera`, `allow_mic`, `open_settings_hint`, `tap_to_end`, `ten_sec_remaining`, `two_min_remaining`, `n_min_remaining`
- **call scheduling (prior session)**: call slot, confirm, accept/decline states, ready messages, etc.
- **match toasts (prior session)**: first/second call completed, face call toasts, error toasts
- **chat hints (prior session)**: `hint_first_call_ready`, `hint_second_call_ready`, and related
- **intent wheel (prior session)**: `wheel_title`, `wheel_desc`, `spin_btn`, etc.

### `client/src/pages/matches.tsx`
- `RequestCard` component: "Decline" button → `t("decline_label")`
- Match-accepted toast description: template literal → `t("now_matched_desc").replace("{name}", …)`
- Match-declined toast description: template literal → `t("passed_on_desc").replace("{name}", …)`
- `generateDateSlots(t)`: refactored to accept `t` as a parameter (plain functions cannot use hooks); day names, month names, and time-of-day labels all go through `t()`
- Phone exchange hint: "It will be sent as a message to {name}" → `t("phone_sent_as_message").replace("{name}", …)`
- `_MatchChat`: added `const { t } = useLanguageContext()` (was missing)
- `MatchCard`: added `const { t } = useLanguageContext()` (was missing)
- Inline call overlay: "Decline" → `t("decline_label")`, "Answering…"/"Answer" → `t()`
- All call-lifecycle toasts, stage hints, textarea placeholders, face-call UI — all through `t()`

### `client/src/pages/onboarding.tsx`
- `OnboardingPage`: all placeholder strings → `t()` keys; "Add" buttons → `t("add_label")`; "Creating..."/"Complete Profile" → `t()`
- Submit button: `STEPS.length` (undefined — removed in prior session) replaced with `STEP_KEYS.length` (the current constant)
- `PhotoSlot`: added `const { t } = useLanguageContext()`; photo error toast → `t()`

### `client/src/pages/elevate-success.tsx`
- `LiveStatusCard`: "Super Elevate"/"Elevate" → `t("super_elevate_label")`/`t("elevate_label")`
- `ElevateSuccessPage` header: type label → `t()`
- Boost detail line: → `t("boost_started_now")` with `.replace()` substitutions

### `client/src/components/active-call.tsx`
- `stageLabel`: all three stages → `t()` keys
- Timer-expiry `useEffect`: completion messages → `t()` keys; renamed `const t = setTimeout` → `const tid` / `const tid2` (eliminated variable shadowing)
- `statusLabel` IIFE: all connection state strings → `t()` keys
- Permission-denied screen: title, body text, settings hint, "Tap to end call" → `t()` keys
- Time-remaining hint: all warning labels → `t()` with `{n}` substitution

## Strings Intentionally NOT Translated

The following are dynamic user content and must stay as-is:
- Profile `firstName`, `age`, `datingIntent`, `location`, `height`
- Chat message `content`
- Conversation starter text and user-typed answers
- Profile question answers
- `match.profile.datingIntent` shown as a preview in match list

## TypeScript Status (`npx tsc --noEmit`)

**Errors introduced by this i18n work: 0**

Pre-existing errors (present before this task, unrelated to i18n):
- `active-call.tsx(935)` — implicit `any` in memo callback
- `i18n.ts(30)` — `Set<string>` assignability issue (separate from our en-block additions)
- `matches.tsx(909, 1142, 1917)` — type mismatches in ProfilePhotoViewer and optimistic message timestamps
