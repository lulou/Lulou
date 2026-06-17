import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

// ── Visible crash fallback ────────────────────────────────────────────────────
// If the JS bundle or React itself crashes before/during mount, the user sees
// a readable error instead of a blank white page.  This runs BEFORE any module
// import so it catches synchronous module-init throws too.
function showFatalError(title: string, detail: string): void {
  const el = document.getElementById("root");
  if (!el) return;
  el.innerHTML = [
    '<div style="min-height:100vh;display:flex;align-items:center;justify-content:center;',
    'background:#faf8f5;padding:24px;font-family:system-ui,sans-serif;">',
    '<div style="max-width:480px;text-align:center;">',
    '<div style="width:56px;height:56px;border-radius:50%;background:#fee2e2;',
    'display:flex;align-items:center;justify-content:center;margin:0 auto 20px;">',
    '<svg width="24" height="24" fill="none" stroke="#dc2626" stroke-width="2" ',
    'viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" ',
    'x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg></div>',
    '<h1 style="font-size:18px;font-weight:600;color:#1a1a1a;margin:0 0 12px">',
    title.replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c)),
    '</h1>',
    '<p style="font-size:14px;color:#555;line-height:1.6;margin:0 0 8px;word-break:break-word;">',
    detail.replace(/[<>&"]/g, c => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c] ?? c)),
    '</p>',
    '<p style="font-size:12px;color:#888;margin:0 0 20px">',
    'Open browser DevTools (F12) → Console for the full error.',
    '</p>',
    '<button onclick="location.reload()" ',
    'style="padding:10px 24px;border-radius:8px;background:#be4b61;color:white;',
    'border:none;cursor:pointer;font-size:14px;font-weight:500">',
    'Try again</button>',
    '</div></div>',
  ].join("");
}

// Catches crashes from OTHER modules loaded after this handler is registered
window.addEventListener("error", (e) => {
  const root = document.getElementById("root");
  const isEmpty = !root || root.childElementCount === 0;
  if (isEmpty) {
    showFatalError(
      "Lulou failed to start",
      e.message || "An unexpected error occurred during startup.",
    );
  }
});

window.addEventListener("unhandledrejection", (e) => {
  const root = document.getElementById("root");
  const isEmpty = !root || root.childElementCount === 0;
  if (isEmpty) {
    const msg = e.reason instanceof Error ? e.reason.message : String(e.reason ?? "Unknown error");
    showFatalError("Lulou failed to start", msg);
  }
});

try {
  createRoot(document.getElementById("root")!).render(<App />);
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e ?? "Unknown startup error");
  showFatalError("Lulou failed to start", msg);
}
