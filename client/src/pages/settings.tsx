import { useState } from "react";
import type { ReactNode } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { Switch } from "@/components/ui/switch";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  ArrowLeft,
  ChevronRight,
  LogOut,
  Trash2,
  PauseCircle,
  Eye,
  Camera,
  ShieldOff,
  Filter,
  Bot,
  FileText,
  Phone,
  Mail,
  Bell,
  Crown,
  Globe,
  Ruler,
  Lock,
  Download,
  Heart,
  BookOpen,
  Users,
  Shield,
} from "lucide-react";
import type { Profile } from "@shared/schema";

// Persist a boolean toggle to localStorage so it survives page refreshes.
function useToggle(key: string, defaultVal = false): [boolean, (v: boolean) => void] {
  const [val, setVal] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(`settings_${key}`);
      return v !== null ? v === "true" : defaultVal;
    } catch { return defaultVal; }
  });
  const set = (next: boolean) => {
    setVal(next);
    try { localStorage.setItem(`settings_${key}`, String(next)); } catch {}
  };
  return [val, set];
}

export default function SettingsPage() {
  const [, navigate] = useLocation();
  const { user, logout, isLoggingOut } = useAuth();
  const { toast } = useToast();

  const { data: profile } = useQuery<Profile>({ queryKey: ["/api/profile"] });

  // ── Toggle preferences ────────────────────────────────────────────────────
  const [showLastActive, setShowLastActive] = useToggle("show_last_active", true);
  const [commentFilter,  setCommentFilter]  = useToggle("comment_filter", true);
  const [aiStarters, setAiStarters]         = useToggle("conversation_starter_ai", true);
  const [audioTranscripts, setAudioTranscripts] = useToggle("audio_transcripts", false);
  const [pushNotifications, setPushNotifications] = useToggle("push_notifications", true);

  // ── Confirmation dialogs ──────────────────────────────────────────────────
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [showPauseDialog,  setShowPauseDialog]  = useState(false);

  const handleLogout = async () => {
    await logout();
  };

  const handleDeleteConfirm = () => {
    setShowDeleteDialog(false);
    toast({
      title: "Account deletion requested",
      description: "Email support@lulou.dating to complete deletion. We'll process it within 48 hours.",
    });
  };

  const handlePauseConfirm = () => {
    setShowPauseDialog(false);
    toast({
      title: "Account paused",
      description: "Your profile is hidden from discovery. Reactivate anytime from Settings.",
    });
  };

  const comingSoon = (name: string) =>
    toast({ title: "Coming soon", description: `${name} will be available shortly.` });

  return (
    <div className="flex-1 flex flex-col bg-background overflow-hidden" data-testid="settings-page">

      {/* ── Sticky header ── */}
      <div className="sticky top-0 z-20 bg-background/95 backdrop-blur-sm border-b shrink-0">
        <div className="flex items-center gap-3 px-4 py-3.5 max-w-lg mx-auto w-full">
          <button
            onClick={() => navigate("/profile")}
            className="w-9 h-9 flex items-center justify-center rounded-full hover:bg-muted transition-colors shrink-0"
            data-testid="button-settings-back"
            aria-label="Back to profile"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <h1 className="font-serif text-xl font-bold">Settings</h1>
        </div>
      </div>

      {/* ── Scrollable content ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto w-full pb-28">

          {/* ── 1. Account ── */}
          <SectionHeader title="Account" first />
          <SettingRow
            icon={<PauseCircle className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Pause account"
            description="Hide your profile temporarily"
            onPress={() => setShowPauseDialog(true)}
            testId="button-pause-account"
          />
          <SettingRow
            icon={<Trash2 className="w-[18px] h-[18px] text-destructive" />}
            label="Delete account"
            labelClass="text-destructive"
            description="Permanently remove your profile and data"
            onPress={() => setShowDeleteDialog(true)}
            testId="button-delete-account"
          />
          <SettingRow
            icon={<LogOut className="w-[18px] h-[18px] text-destructive" />}
            label={isLoggingOut ? "Logging out…" : "Log out"}
            labelClass="text-destructive"
            onPress={handleLogout}
            showChevron={false}
            testId="button-settings-logout"
          />

          {/* ── 2. Profile & Visibility ── */}
          <SectionHeader title="Profile & Visibility" />
          <SettingRow
            icon={<Eye className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Show last active status"
            description="Let matches see when you were last online"
            trailing={
              <Switch
                checked={showLastActive}
                onCheckedChange={setShowLastActive}
                data-testid="switch-last-active"
              />
            }
            showChevron={false}
            testId="row-last-active"
          />
          <SettingRow
            icon={<Camera className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Selfie verification"
            description="Get a verified badge on your profile"
            onPress={() => comingSoon("Selfie verification")}
            testId="button-selfie-verification"
          />
          <SettingRow
            icon={<ShieldOff className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Block list"
            description="Manage who can't see or contact you"
            onPress={() => comingSoon("Block list")}
            testId="button-block-list"
          />
          <SettingRow
            icon={<Filter className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Comment filter"
            description="Automatically block disrespectful words"
            trailing={
              <Switch
                checked={commentFilter}
                onCheckedChange={setCommentFilter}
                data-testid="switch-comment-filter"
              />
            }
            showChevron={false}
            testId="row-comment-filter"
          />

          {/* ── 3. AI & Chat ── */}
          <SectionHeader title="AI & Chat" />
          <SettingRow
            icon={<Bot className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Conversation starter AI"
            description="AI-suggested ice-breakers to help you begin"
            trailing={
              <Switch
                checked={aiStarters}
                onCheckedChange={setAiStarters}
                data-testid="switch-ai-starters"
              />
            }
            showChevron={false}
            testId="row-ai-starters"
          />
          <SettingRow
            icon={<FileText className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Audio transcripts"
            description="Get text transcripts of your voice calls"
            trailing={
              <Switch
                checked={audioTranscripts}
                onCheckedChange={setAudioTranscripts}
                data-testid="switch-audio-transcripts"
              />
            }
            showChevron={false}
            testId="row-audio-transcripts"
          />

          {/* ── 4. Contact & Security ── */}
          <SectionHeader title="Contact & Security" />
          <ContactRow
            icon={<Phone className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Phone number"
            value={profile?.phoneNumber || "Not added"}
            testId="text-settings-phone"
          />
          <ContactRow
            icon={<Mail className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Email address"
            value={profile?.email || user?.email || "Not added"}
            testId="text-settings-email"
          />
          {/* Connected accounts */}
          <div className="px-4 py-4 border-b border-border/50">
            <div className="flex items-center gap-3 mb-3">
              <Lock className="w-[18px] h-[18px] text-muted-foreground shrink-0" />
              <p className="text-sm font-medium">Connected accounts</p>
            </div>
            <div className="space-y-2.5 pl-[30px]">
              <ConnectedAccountRow provider="Google" connected={false} />
              <ConnectedAccountRow provider="Apple"  connected={false} />
            </div>
          </div>

          {/* ── 5. Notifications ── */}
          <SectionHeader title="Notifications" />
          <SettingRow
            icon={<Bell className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Push notifications"
            description="Match alerts, messages, and call reminders"
            trailing={
              <Switch
                checked={pushNotifications}
                onCheckedChange={setPushNotifications}
                data-testid="switch-push-notifications"
              />
            }
            showChevron={false}
            testId="row-push-notifications"
          />

          {/* ── 6. Subscription ── */}
          <SectionHeader title="Subscription" />
          <SettingRow
            icon={<Crown className="w-[18px] h-[18px] text-primary" />}
            label="Subscribe to Lulou"
            description="Unlock extras and deeper connections — $19.99/month"
            onPress={() => navigate("/profile")}
            testId="button-settings-subscribe"
          />

          {/* ── 7. Preferences ── */}
          <SectionHeader title="Preferences" />
          <SettingRow
            icon={<Globe className="w-[18px] h-[18px] text-muted-foreground" />}
            label="App language"
            value="English"
            onPress={() => comingSoon("Language settings")}
            testId="button-settings-language"
          />
          <SettingRow
            icon={<Ruler className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Units of measurement"
            value="Miles & feet"
            onPress={() => comingSoon("Units settings")}
            testId="button-settings-units"
          />

          {/* ── 8. Legal & Safety ── */}
          <SectionHeader title="Legal & Safety" />
          <SettingRow
            icon={<Shield className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Privacy Policy"
            onPress={() => window.open("https://lulou.dating/privacy", "_blank")}
            testId="button-privacy-policy"
          />
          <SettingRow
            icon={<BookOpen className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Terms of Service"
            onPress={() => window.open("https://lulou.dating/terms", "_blank")}
            testId="button-terms-of-service"
          />
          <SettingRow
            icon={<Lock className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Privacy Preferences"
            onPress={() => comingSoon("Privacy preferences")}
            testId="button-privacy-preferences"
          />
          <SettingRow
            icon={<FileText className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Licences"
            onPress={() => comingSoon("Licences")}
            testId="button-licences"
          />
          <SettingRow
            icon={<Download className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Download my data"
            onPress={() => comingSoon("Data download")}
            testId="button-download-data"
          />
          <SettingRow
            icon={<Heart className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Safe dating tips"
            onPress={() => comingSoon("Safe dating tips")}
            testId="button-safe-dating"
          />
          <SettingRow
            icon={<Users className="w-[18px] h-[18px] text-muted-foreground" />}
            label="Member principles"
            onPress={() => comingSoon("Member principles")}
            testId="button-member-principles"
          />

          {/* Version footer */}
          <p className="text-center text-xs text-muted-foreground/40 pt-8 pb-2 select-none">
            Lulou Dating · v1.0
          </p>
        </div>
      </div>

      {/* ── Delete confirmation ── */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your account?</AlertDialogTitle>
            <AlertDialogDescription>
              This permanently removes your profile, all matches, and all messages. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-delete-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-delete-confirm"
            >
              Delete account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* ── Pause confirmation ── */}
      <AlertDialog open={showPauseDialog} onOpenChange={setShowPauseDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Pause your account?</AlertDialogTitle>
            <AlertDialogDescription>
              Your profile will be hidden from discovery. Your matches and conversations are kept safe. You can reactivate anytime from Settings.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-pause-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handlePauseConfirm} data-testid="button-pause-confirm">
              Pause account
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

// ── Sub-components ────────────────────────────────────────────────────────────

function SectionHeader({ title, first }: { title: string; first?: boolean }) {
  return (
    <div className={`px-4 pb-2 ${first ? "pt-5" : "pt-7"}`}>
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/65">
        {title}
      </p>
    </div>
  );
}

function SettingRow({
  icon,
  label,
  labelClass,
  description,
  value,
  trailing,
  showChevron = true,
  onPress,
  testId,
}: {
  icon: ReactNode;
  label: string;
  labelClass?: string;
  description?: string;
  value?: string;
  trailing?: ReactNode;
  showChevron?: boolean;
  onPress?: () => void;
  testId?: string;
}) {
  const content = (
    <>
      <span className="shrink-0 flex items-center justify-center w-7">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className={`block text-sm font-medium leading-snug ${labelClass ?? ""}`}>{label}</span>
        {description && (
          <span className="block text-xs text-muted-foreground mt-0.5 leading-snug">{description}</span>
        )}
      </span>
      {value && (
        <span className="text-sm text-muted-foreground shrink-0 mr-0.5">{value}</span>
      )}
      {trailing && (
        <span onClick={e => e.stopPropagation()}>{trailing}</span>
      )}
      {showChevron && !trailing && (
        <ChevronRight className="w-4 h-4 text-muted-foreground/40 shrink-0" />
      )}
    </>
  );

  const baseClass =
    "w-full px-4 py-3.5 flex items-center gap-3 border-b border-border/50 text-left";

  if (onPress) {
    return (
      <button
        className={`${baseClass} hover:bg-muted/50 active:bg-muted transition-colors`}
        onClick={onPress}
        data-testid={testId}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={baseClass} data-testid={testId}>
      {content}
    </div>
  );
}

function ContactRow({
  icon,
  label,
  value,
  testId,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  testId?: string;
}) {
  return (
    <div className="px-4 py-3.5 flex items-center gap-3 border-b border-border/50">
      <span className="shrink-0 flex items-center justify-center w-7">{icon}</span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-medium leading-snug">{label}</span>
        <span className="block text-xs text-muted-foreground mt-0.5 leading-snug" data-testid={testId}>
          {value}
        </span>
      </span>
    </div>
  );
}

function ConnectedAccountRow({
  provider,
  connected,
}: {
  provider: "Google" | "Apple";
  connected: boolean;
}) {
  return (
    <div className="flex items-center justify-between">
      <p className="text-sm text-muted-foreground">{provider}</p>
      <span
        className={`text-xs font-medium px-2.5 py-1 rounded-full ${
          connected
            ? "bg-primary/10 text-primary"
            : "bg-muted text-muted-foreground"
        }`}
        data-testid={`badge-connected-${provider.toLowerCase()}`}
      >
        {connected ? "Connected" : "Not connected"}
      </span>
    </div>
  );
}
