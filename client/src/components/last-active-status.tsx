import { useLanguageContext } from "@/contexts/language-context";
import { isActiveToday } from "@/lib/last-active";

export function LastActiveStatus({
  lastActive,
  showLastActive = true,
  className = "",
  testId = "text-last-active",
}: {
  lastActive: Date | string | null | undefined;
  showLastActive?: boolean;
  className?: string;
  testId?: string;
}) {
  const { t } = useLanguageContext();
  if (!isActiveToday(lastActive, showLastActive)) return null;
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-semibold leading-none text-emerald-600 dark:text-emerald-400 ${className}`} data-testid={testId}>
      <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
      {t("active_today")}
    </span>
  );
}