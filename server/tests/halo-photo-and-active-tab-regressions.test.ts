import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const likesPage = readFileSync("client/src/pages/likes.tsx", "utf8");
const matchesPage = readFileSync("client/src/pages/matches.tsx", "utf8");

describe("Halo photo and Active Chats presentation regressions", () => {
  const sparkCard = likesPage.slice(
    likesPage.indexOf("function SparkCard("),
    likesPage.indexOf("// ─── Empty State", likesPage.indexOf("function SparkCard(")),
  );

  it("loads Halo photos from the canonical per-profile endpoint", () => {
    expect(sparkCard).toContain(
      'queryKey: ["/api/profiles", spark.profile.userId ?? spark.fromUserId, "photos"]',
    );
    expect(sparkCard).toContain("photosData?.photos ?? spark.profile.photos");
  });

  it("tries the next photo after a broken image", () => {
    expect(sparkCard).toContain("haloPhotos[photoIndex]");
    expect(sparkCard).toContain("onError={() => setPhotoIndex(index => index + 1)}");
  });

  it("never renders a numeric or initial placeholder as the Halo image", () => {
    expect(sparkCard).not.toContain("spark.profile.firstName?.[0]");
    expect(sparkCard).toContain("<Sparkles");
  });

  it("uses the approved deep SPIN wine only for the selected Active Chats tab", () => {
    const activeTab = matchesPage.slice(
      matchesPage.indexOf('data-testid="tab-active-chats"') - 500,
      matchesPage.indexOf('data-testid="tab-active-chats"') + 500,
    );
    const newTab = matchesPage.slice(
      matchesPage.indexOf('data-testid="tab-new-connections"') - 500,
      matchesPage.indexOf('data-testid="tab-new-connections"') + 500,
    );

    expect(activeTab).toContain("text-[#773846] border-[#773846]");
    expect(activeTab).not.toContain(
      'activeTab === "active" ? "text-primary border-primary"',
    );
    expect(newTab).toContain('activeTab === "new" ? "text-primary border-primary"');
  });
});