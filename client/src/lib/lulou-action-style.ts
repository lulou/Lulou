// Exact palette values used by the production Open / Close action treatment.
export const LULOU_SELECTED_ACCENT = "#773846";
export const LULOU_ACTIVE_CHAT_SURFACE = "#fff4f6";
export const LULOU_ACTIVE_CHAT_BORDER = "#e5cdd2";
export const LULOU_ACTIVE_CHAT_NAME = "#35282b";
export const LULOU_ACTIVE_CHAT_PREVIEW = "#817277";
export const LULOU_ACTIVE_CHAT_CHEVRON = "#8b5665";

// Shared premium rose treatment for primary Lulou actions.
// Keep Discover actions and the Intention Wheel Spin button visually aligned.
export const LULOU_SPIN_ACTION_STYLE = {
  background: `radial-gradient(circle at 36% 28%, #c6777f 0%, #a15360 38%, ${LULOU_SELECTED_ACCENT} 100%)`,
  border: "1px solid rgba(255,231,223,0.28)",
  boxShadow: "0 12px 28px rgba(54,20,29,0.42), inset 0 1px 0 rgba(255,255,255,0.22), inset 0 -10px 22px rgba(52,19,29,0.16)",
  color: "#fff",
} as const;