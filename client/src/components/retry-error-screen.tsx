/**
 * RetryErrorScreen — shared full-screen error + retry component.
 *
 * Used by:
 *  - Connections (matches.tsx) "Something went wrong" / "Try Again"
 *  - App.tsx "Session verification failed" / "Retry"
 *
 * Props are deliberately simple so each screen can own its own copy text.
 */
import { AlertCircle, Moon } from "lucide-react";

interface RetryErrorScreenProps {
  /** Main heading */
  title: string;
  /** Sub-heading / explanation */
  message: string;
  /** Button label when idle */
  retryLabel?: string;
  /** Button label while the retry request is in-flight */
  retryingLabel?: string;
  /** Whether a retry is currently in-flight */
  isRetrying: boolean;
  /** Called when the user presses Retry */
  onRetry: () => void;
  /** If provided, renders a secondary "Sign out" button */
  onSignOut?: () => void;
  /** Optional error detail — shown in small mono text (dev or after failure) */
  errorDetail?: string;
  /** Icon variant — "alert" (red, default) | "moon" (destructive) */
  icon?: "alert" | "moon";
  /** Slot for the dev diagnostic panel */
  children?: React.ReactNode;
}

export function RetryErrorScreen({
  title,
  message,
  retryLabel = "Try Again",
  retryingLabel = "Trying again…",
  isRetrying,
  onRetry,
  onSignOut,
  errorDetail,
  icon = "alert",
  children,
}: RetryErrorScreenProps) {
  return (
    <div className="min-h-[60vh] flex items-center justify-center p-6">
      <div className="text-center space-y-4 max-w-sm w-full">
        {/* Icon */}
        <div className="w-16 h-16 rounded-full bg-destructive/10 flex items-center justify-center mx-auto">
          {icon === "moon" ? (
            <Moon className="w-8 h-8 text-destructive" />
          ) : (
            <AlertCircle className="w-8 h-8 text-destructive" />
          )}
        </div>

        {/* Text */}
        <div className="space-y-1.5">
          <h2 className="font-serif text-xl font-bold">{title}</h2>
          <p className="text-muted-foreground text-sm">{message}</p>
          {errorDetail && (
            <p className="text-xs text-muted-foreground/70 font-mono break-all mt-1">
              {errorDetail}
            </p>
          )}
        </div>

        {/* Buttons */}
        <div className="flex flex-col gap-2 w-full">
          <button
            onClick={onRetry}
            disabled={isRetrying}
            data-testid="button-retry"
            className="w-full py-2.5 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-60 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isRetrying && (
              <svg
                className="w-4 h-4 animate-spin"
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                />
              </svg>
            )}
            {isRetrying ? retryingLabel : retryLabel}
          </button>

          {onSignOut && (
            <button
              onClick={onSignOut}
              className="w-full py-2.5 px-4 rounded-lg border border-border bg-background text-sm font-medium text-foreground hover:bg-muted transition-colors"
            >
              Sign out
            </button>
          )}
        </div>

        {/* Diagnostic panel slot */}
        {children}
      </div>
    </div>
  );
}
