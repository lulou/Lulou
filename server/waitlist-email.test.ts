import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { waitlistInviteEmail, waitlistVerifiedEmail, waitlistVerifyEmail } from "./emailTemplates";

const origin = "https://lulouapp.vercel.app";

describe("waitlist transactional emails", () => {
  it("escapes untrusted names and uses only the approved Lulou colour and logo", () => {
    const html = waitlistVerifyEmail('<img src=x onerror="alert(1)">', `${origin}/waitlist/verify?token=example`);
    assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
    assert.ok(!html.includes('<img src=x onerror="alert(1)">'));
    assert.ok(html.includes(`${origin}/lulou-logo-master.png`));
    assert.ok(html.includes("background:#945064"));
    assert.ok(!html.includes("🌸"));
  });

  it("includes a confirmation link but does not create a dating account", () => {
    const html = waitlistVerifyEmail("Alex", `${origin}/waitlist/verify?token=example`);
    assert.ok(html.includes("Confirm Early Access"));
    assert.ok(html.includes(`${origin}/waitlist/verify?token=example`));
    assert.ok(html.includes("expires in 24 hours"));
  });

  it("gives verified members their personal referral link without promising a wave", () => {
    const html = waitlistVerifiedEmail("Alex", `${origin}/waitlist?r=ABC123`);
    assert.ok(html.includes(`${origin}/waitlist?r=ABC123`));
    assert.ok(html.includes("don’t guarantee"));
  });

  it("invites members to existing signup without activating their account", () => {
    const html = waitlistInviteEmail("Alex", `${origin}/?mode=signup`);
    assert.ok(html.includes(`${origin}/?mode=signup`));
    assert.ok(html.includes("Create your account"));
  });
});