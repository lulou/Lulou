import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const likesPage = readFileSync("client/src/pages/likes.tsx", "utf8");
const matchesPage = readFileSync("client/src/pages/matches.tsx", "utf8");
const appLayout = readFileSync("client/src/components/app-layout.tsx", "utf8");
const actionStyle = readFileSync("client/src/lib/lulou-action-style.ts", "utf8");

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

  it("uses the exact Open / Close wine stop for selected connection tabs", () => {
    const activeTab = matchesPage.slice(
      matchesPage.indexOf('data-testid="tab-active-chats"') - 500,
      matchesPage.indexOf('data-testid="tab-active-chats"') + 500,
    );
    const newTab = matchesPage.slice(
      matchesPage.indexOf('data-testid="tab-new-connections"') - 500,
      matchesPage.indexOf('data-testid="tab-new-connections"') + 500,
    );

    expect(actionStyle).toContain('export const LULOU_SELECTED_ACCENT = "#773846"');
    expect(activeTab).toContain("color: LULOU_SELECTED_ACCENT");
    expect(activeTab).toContain("borderColor: LULOU_SELECTED_ACCENT");
    expect(newTab).toContain("color: LULOU_SELECTED_ACCENT");
    expect(newTab).toContain("borderColor: LULOU_SELECTED_ACCENT");
  });

  it("uses the Open / Close wine stop for selected bottom navigation only", () => {
    expect(appLayout).toContain("style={isActive ? { color: LULOU_SELECTED_ACCENT } : undefined}");
    expect(appLayout).toContain('"text-muted-foreground/70 hover:text-muted-foreground"');
  });

  it("applies the premium dark-wine treatment only to Active Chats cards", () => {
    expect(actionStyle).toContain('export const LULOU_ACTIVE_CHAT_SURFACE = "#351520"');
    expect(matchesPage).toContain("activeChat?: boolean");
    expect(matchesPage).toContain("background: LULOU_ACTIVE_CHAT_SURFACE");
    expect(matchesPage).toContain("color: LULOU_ACTIVE_CHAT_NAME");
    expect(matchesPage).toContain("color: LULOU_ACTIVE_CHAT_PREVIEW");
    expect(matchesPage).toContain("color: LULOU_ACTIVE_CHAT_CHEVRON");

    const activePanel = matchesPage.slice(
      matchesPage.indexOf('data-testid="tab-panel-active"'),
      matchesPage.indexOf("</div>", matchesPage.indexOf('data-testid="tab-panel-active"')) + 1000,
    );
    const newPanel = matchesPage.slice(
      matchesPage.indexOf('data-testid="tab-panel-new"'),
      matchesPage.indexOf('data-testid="tab-panel-active"'),
    );
    expect(activePanel).toMatch(/\n\s+activeChat\s*\n/);
    expect(newPanel).not.toMatch(/\n\s+activeChat\s*\n/);
  });
});