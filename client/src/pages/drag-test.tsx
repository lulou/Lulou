import { DragPhotoViewer } from "@/components/drag-photo-viewer";

// Two stable public images — no auth required, no backend.
// Replace with real Supabase profile-photo URLs once drag is confirmed working.
const TEST_PHOTOS = [
  "https://images.unsplash.com/photo-1529626455594-4ff0802cfb7e?w=600&q=80",
  "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=600&q=80",
  "https://images.unsplash.com/photo-1544005313-94ddf0286df2?w=600&q=80",
];

export default function DragTestPage() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        background: "#111",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: 24,
        gap: 16,
      }}
    >
      <p style={{ color: "white", fontFamily: "sans-serif", fontSize: 13, opacity: 0.6, margin: 0 }}>
        Drag left/right to test · vertical scroll still works · dots update on swipe
      </p>

      <div style={{ width: "100%", maxWidth: 400 }}>
        <DragPhotoViewer photos={TEST_PHOTOS} height={500} />
      </div>

      <p style={{ color: "white", fontFamily: "sans-serif", fontSize: 12, opacity: 0.4, margin: 0 }}>
        /drag-test — isolated component, not connected to Discovery
      </p>

      {/* Extra content below so vertical scroll is testable */}
      <div style={{ height: 600, width: "100%", maxWidth: 400 }}>
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            style={{
              height: 60,
              marginBottom: 12,
              borderRadius: 8,
              background: "rgba(255,255,255,0.06)",
              display: "flex",
              alignItems: "center",
              paddingLeft: 16,
              color: "rgba(255,255,255,0.3)",
              fontFamily: "sans-serif",
              fontSize: 13,
            }}
          >
            Scroll content row {i + 1}
          </div>
        ))}
      </div>
    </div>
  );
}
