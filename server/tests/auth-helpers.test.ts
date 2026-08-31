import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase", () => ({
  supabase: {
    auth: {
      resend: vi.fn(),
    },
  },
}));

import { classifyVerificationDeliveryError } from "../../client/src/lib/auth-helpers";

describe("classifyVerificationDeliveryError", () => {
  it.each([
    [{ status: 429, code: "over_email_send_rate_limit", message: "Email rate limit exceeded" }, "resend", "rate_limited"],
    [{ status: 500, code: "smtp_error", message: "SMTP server rejected sender" }, "resend", "smtp_failure"],
    [{ status: 400, code: "email_address_invalid", message: "Invalid email" }, "signup", "invalid_email"],
    [{ status: 500, code: "unexpected", message: "Database error saving new user" }, "signup", "auth_user_creation_failure"],
    [{ status: 400, code: "confirmation_failed", message: "Could not send confirmation" }, "resend", "confirmation_send_failure"],
    [{ status: 400, code: "validation_failed", message: "Redirect URL is not allowed" }, "signup", "redirect_configuration"],
    [{ status: 503, code: "upstream_error", message: "Upstream service unavailable" }, "signup", "provider_error"],
    [{ status: 418, code: "unexpected", message: "Unrecognised response" }, "signup", "unknown"],
  ] as const)(
    "classifies %s as %s",
    (error, phase, expected) => {
      expect(classifyVerificationDeliveryError(error, phase).kind).toBe(expected);
    },
  );

  it("redacts emails, URLs, and tokens from diagnostic detail", () => {
    const failure = classifyVerificationDeliveryError(
      {
        status: 500,
        message:
          "Failed for person@example.com at https://example.com/auth?token_hash=secret-value eyJabc.def.ghi",
      },
      "resend",
    );

    expect(failure.safeDetail).not.toContain("person@example.com");
    expect(failure.safeDetail).not.toContain("https://example.com");
    expect(failure.safeDetail).not.toContain("eyJabc.def.ghi");
  });
});