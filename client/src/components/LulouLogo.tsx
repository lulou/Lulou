/**
 * LulouLogo — the single canonical Lulou brand logo component.
 *
 * Renders the approved dark-plum double-L heart monogram from the master PNG.
 * Use this component everywhere the Lulou logo appears instead of duplicating
 * logo markup.
 *
 * Props:
 *  size      — pixel size (square). Applied as both width and height in px.
 *              Ignored when className already provides w-* / h-* Tailwind classes.
 *  className — Tailwind / CSS classes (e.g. "w-8 h-8 opacity-80").
 *  alt       — accessible alt text. Defaults to "Lulou".
 *  rounded   — when true, applies 22% border-radius matching the logo's
 *              rounded-square shape so it sits flush on any background.
 */
export interface LulouLogoProps {
  size?: number;
  className?: string;
  alt?: string;
  rounded?: boolean;
}

export function LulouLogo({
  size,
  className,
  alt = "Lulou",
  rounded = false,
}: LulouLogoProps) {
  return (
    <img
      src="/lulou-logo-master.png"
      alt={alt}
      draggable={false}
      className={className}
      style={{
        ...(size !== undefined ? { width: size, height: size } : {}),
        objectFit: "contain",
        ...(rounded ? { borderRadius: "22%" } : {}),
      }}
    />
  );
}

export default LulouLogo;
