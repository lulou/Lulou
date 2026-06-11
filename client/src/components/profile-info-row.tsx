import { getStarSign, STAR_SIGN_EMOJI } from "@/lib/star-sign";

interface ProfileInfoRowProps {
  age?: number | string | null;
  location?: string | null;
  height?: string | null;
  dateOfBirth?: string | null;
  pronouns?: string | null;
  className?: string;
}

export function ProfileInfoRow({ age, location, height, dateOfBirth, pronouns, className }: ProfileInfoRowProps) {
  const starSign = getStarSign(dateOfBirth);

  const items: { label: string; value: string; testId: string }[] = [
    ...(age != null ? [{ label: "Age", value: String(age), testId: "text-profile-info-age" }] : []),
    ...(location ? [{ label: "Location", value: location, testId: "text-profile-info-location" }] : []),
    ...(height ? [{ label: "Height", value: height, testId: "text-profile-info-height" }] : []),
    ...(starSign ? [{ label: "Star Sign", value: `${STAR_SIGN_EMOJI[starSign]} ${starSign}`, testId: "text-profile-info-star-sign" }] : []),
    ...(pronouns ? [{ label: "Pronouns", value: pronouns, testId: "text-profile-info-pronouns" }] : []),
  ];

  if (items.length === 0) return null;

  return (
    <div
      className={`grid grid-cols-2 gap-x-6 gap-y-3 ${className ?? ""}`}
      data-testid="section-profile-info"
    >
      {items.map(({ label, value, testId }) => (
        <div key={label}>
          <p className="text-[10px] font-semibold tracking-widest uppercase text-muted-foreground">{label}</p>
          <p className="text-sm font-medium text-foreground mt-0.5" data-testid={testId}>{value}</p>
        </div>
      ))}
    </div>
  );
}
