import { useState, useRef, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { supabase } from "@/lib/supabase";
import { useUnits } from "@/lib/units";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
  PlayCircle,
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
  Plus,
  X,
  CheckCircle2,
  Link,
  Link2Off,
} from "lucide-react";
import type { Profile, BlockedContact } from "@shared/schema";
import { useLanguageContext } from "@/contexts/language-context";

const LANGUAGES = [
  "English", "Spanish", "French", "German", "Portuguese",
  "Italian", "Dutch", "Polish", "Russian", "Arabic",
  "Chinese (Simplified)", "Chinese (Traditional)", "Japanese",
  "Korean", "Hindi", "Swahili",
];

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


type ActiveSheet = "selfie" | "blocklist" | "extras" | "language" | "units" | "privacy" | "terms" | "download_data" | "safety" | "principles" | "licences" | "privacy_prefs" | null;

export default function SettingsPage() {
  const [, navigate] = useLocation();
  const { user, logout, isLoggingOut } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: profile } = useQuery<Profile>({ queryKey: ["/api/profile"] });
  const { data: blockedContacts = [] } = useQuery<BlockedContact[]>({ queryKey: ["/api/blocked-contacts"] });

  // ── Toggle preferences ────────────────────────────────────────────────────
  const [showLastActive,    setShowLastActive]    = useToggle("show_last_active", true);
  const [commentFilter,     setCommentFilter]     = useToggle("comment_filter", true);
  const [aiStarters,        setAiStarters]        = useToggle("conversation_starter_ai", true);
  const [audioTranscripts,  setAudioTranscripts]  = useToggle("audio_transcripts", false);
  const [pushNotifications, setPushNotifications] = useToggle("push_notifications", true);

  // ── Active sheets / dialogs ───────────────────────────────────────────────
  const [activeSheet,     setActiveSheet]     = useState<ActiveSheet>(null);
  const [showPhoneDialog, setShowPhoneDialog] = useState(false);
  const [showPauseDialog, setShowPauseDialog] = useState(false);
  const [showDeleteDialog,setShowDeleteDialog]= useState(false);

  // ── Phone edit ────────────────────────────────────────────────────────────
  const [phoneInput, setPhoneInput] = useState("");

  // ── Language ──────────────────────────────────────────────────────────────
  const { language, setLanguage, t } = useLanguageContext();

  // ── Units ─────────────────────────────────────────────────────────────────
  const [units, setUnits] = useUnits();

  // ── Data export ───────────────────────────────────────────────────────────
  const [isExporting, setIsExporting] = useState(false);

  // ── Connected account loading ─────────────────────────────────────────────
  const [connectingProvider, setConnectingProvider] = useState<string | null>(null);

  // ── Connected accounts ────────────────────────────────────────────────────
  const [identities, setIdentities] = useState<{ provider: string; identity_id: string }[]>([]);
  const [identitiesLoading, setIdentitiesLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        setIdentitiesLoading(true);
        const { data } = await supabase.auth.getUserIdentities();
        setIdentities((data?.identities ?? []).map((i: any) => ({ provider: i.provider, identity_id: i.identity_id })));
      } catch { /* ignore */ }
      finally { setIdentitiesLoading(false); }
    })();
  }, []);

  const isConnected = (provider: string) =>
    identities.some(i => i.provider === provider);

  const handleConnectProvider = async (provider: "google" | "apple") => {
    setConnectingProvider(provider);
    try {
      const { data, error } = await supabase.auth.linkIdentity({
        provider,
        options: { redirectTo: `${window.location.origin}/settings` },
      } as any);
      if (error) throw error;
      const url = (data as any)?.url;
      if (url) {
        window.location.href = url;
      } else {
        toast({ title: `${t("connected_to_provider")} ${provider}` });
      }
    } catch (err: any) {
      const msg = err?.message ?? "";
      const hint = msg.toLowerCase().includes("manual linking")
        ? t("enable_manual_linking")
        : msg;
      toast({ title: t("connect_failed_title"), description: hint, variant: "destructive" });
    } finally {
      setConnectingProvider(null);
    }
  };

  const handleDisconnectProvider = async (provider: string) => {
    const identity = identities.find(i => i.provider === provider);
    if (!identity) return;
    try {
      await supabase.auth.unlinkIdentity(identity as any);
      setIdentities(prev => prev.filter(i => i.provider !== provider));
      toast({ title: t("disconnected_title"), description: `${provider} ${t("provider_removed")}` });
    } catch (err: any) {
      toast({ title: t("could_not_disconnect"), description: err?.message, variant: "destructive" });
    }
  };

  // ── Selfie verification ────────────────────────────────────────────────────
  type SelfieStep = "idle" | "camera" | "preview" | "submitting" | "done";
  const [selfieStep,    setSelfieStep]    = useState<SelfieStep>("idle");
  const [capturedSelfie, setCapturedSelfie] = useState<string | null>(null);
  const videoRef   = useRef<HTMLVideoElement>(null);
  const streamRef  = useRef<MediaStream | null>(null);
  const canvasRef  = useRef<HTMLCanvasElement>(null);

  // Face alignment detection
  const [faceAligned, setFaceAligned]         = useState<null | boolean>(null);
  const faceDetectorRef                        = useRef<any>(null);
  const faceDetectIntervalRef                  = useRef<ReturnType<typeof setInterval> | null>(null);

  // Initialise FaceDetector once (Chromium-only API; no-op elsewhere)
  useEffect(() => {
    if (typeof window !== "undefined" && "FaceDetector" in window) {
      try {
        faceDetectorRef.current = new (window as any).FaceDetector({ maxDetectedFaces: 1, fastMode: true });
      } catch { /* unsupported */ }
    }
  }, []);

  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "user" }, width: { ideal: 640 }, height: { ideal: 640 } },
        audio: false,
      });
      streamRef.current = stream;
      setSelfieStep("camera"); // render <video> element first, then attach in useEffect
    } catch (err: any) {
      const description =
        err?.name === "NotAllowedError"  ? t("cam_permission_denied") :
        err?.name === "NotFoundError"    ? t("cam_not_found") :
        err?.name === "NotReadableError" ? t("cam_in_use") :
                                           t("cam_allow_access");
      toast({ title: t("camera_error_title"), description, variant: "destructive" });
    }
  }, [toast]);

  // Attach stream to <video> after "camera" step renders the element into the DOM
  useEffect(() => {
    if (selfieStep !== "camera") return;
    const video = videoRef.current;
    const stream = streamRef.current;
    if (!video || !stream) return;
    video.srcObject = stream;
    video.play().catch(() => {});
  }, [selfieStep]);

  // Face detection polling — runs while camera is live
  useEffect(() => {
    if (selfieStep !== "camera") {
      setFaceAligned(null);
      if (faceDetectIntervalRef.current) clearInterval(faceDetectIntervalRef.current);
      return;
    }

    const detectFace = async () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || video.videoWidth === 0) return;

      if (faceDetectorRef.current) {
        // FaceDetector API path (Chromium 123+)
        try {
          const faces = await faceDetectorRef.current.detect(video);
          if (faces.length === 0) { setFaceAligned(false); return; }
          const face = faces[0].boundingBox;
          const vw = video.videoWidth, vh = video.videoHeight;
          const cx = (face.x + face.width / 2) / vw;
          const cy = (face.y + face.height / 2) / vh;
          const dist = Math.sqrt((cx - 0.5) ** 2 + (cy - 0.5) ** 2);
          const faceW = face.width / vw;
          setFaceAligned(dist < 0.30 && faceW > 0.18 && faceW < 0.85);
        } catch { setFaceAligned(null); }
      } else {
        // Canvas skin-tone fallback for Firefox / Safari
        const offscreen = document.createElement("canvas");
        offscreen.width = 64; offscreen.height = 64;
        const ctx = offscreen.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(video, 0, 0, 64, 64);
        const { data } = ctx.getImageData(16, 16, 32, 32);
        let skinPx = 0;
        for (let i = 0; i < data.length; i += 4) {
          const r = data[i], g = data[i + 1], b = data[i + 2];
          if (r > 60 && g > 30 && b > 15 && r > g && r > b && r < 250 && r - b > 20 && r - g > 10) skinPx++;
        }
        setFaceAligned(skinPx / (32 * 32) > 0.22);
      }
    };

    // First check after a short delay so the video has time to start
    const warmUp = setTimeout(() => {
      detectFace();
      faceDetectIntervalRef.current = setInterval(detectFace, 400);
    }, 600);

    return () => {
      clearTimeout(warmUp);
      if (faceDetectIntervalRef.current) {
        clearInterval(faceDetectIntervalRef.current);
        faceDetectIntervalRef.current = null;
      }
    };
  }, [selfieStep]);

  const stopCamera = useCallback(() => {
    if (faceDetectIntervalRef.current) {
      clearInterval(faceDetectIntervalRef.current);
      faceDetectIntervalRef.current = null;
    }
    setFaceAligned(null);
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
  }, []);

  const capturePhoto = () => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    canvas.width  = video.videoWidth  || 640;
    canvas.height = video.videoHeight || 640;
    canvas.getContext("2d")?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
    setCapturedSelfie(dataUrl);
    stopCamera();
    setSelfieStep("preview");
  };

  const retakePhoto = () => {
    setCapturedSelfie(null);
    setSelfieStep("idle");
  };

  const selfieVerifyMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/profile", { photoVerified: true }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/profile"] });
      setSelfieStep("done");
      toast({ title: t("verified_title"), description: t("verified_desc_settings") });
    },
    onError: (err: any) => {
        toast({ title: t("verification_failed"), description: err?.message, variant: "destructive" });
    },
  });

  const submitSelfie = () => {
    if (!capturedSelfie) return;
    setSelfieStep("submitting");
    selfieVerifyMutation.mutate();
  };

  useEffect(() => {
    if (activeSheet !== "selfie") {
      stopCamera();
      setSelfieStep("idle");
      setCapturedSelfie(null);
    }
  }, [activeSheet, stopCamera]);

  // ── Pause mutation ────────────────────────────────────────────────────────
  const isPaused = (profile as any)?.isPaused ?? false;

  const pauseMutation = useMutation({
    mutationFn: (paused: boolean) => apiRequest("POST", "/api/profile", { isPaused: paused }),
    onSuccess: (_data, paused) => {
      qc.invalidateQueries({ queryKey: ["/api/profile"] });
      toast({
        title: paused ? t("account_paused_title") : t("account_reactivated_title"),
        description: paused
          ? t("profile_hidden_desc")
          : t("profile_visible_desc"),
      });
    },
    onError: (err: any) => {
      toast({ title: t("failed_toast"), description: err?.message, variant: "destructive" });
    },
  });

  const handlePauseConfirm = () => {
    setShowPauseDialog(false);
    pauseMutation.mutate(!isPaused);
  };

  // ── Phone mutation ────────────────────────────────────────────────────────
  const phoneMutation = useMutation({
    mutationFn: (phoneNumber: string) => apiRequest("POST", "/api/profile", { phoneNumber }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/profile"] });
      setShowPhoneDialog(false);
      toast({ title: t("phone_updated_title") });
    },
    onError: (err: any) => {
      toast({ title: t("failed_to_save"), description: err?.message, variant: "destructive" });
    },
  });

  // ── Blocked contacts mutations ────────────────────────────────────────────
  const [addName,  setAddName]  = useState("");
  const [addPhone, setAddPhone] = useState("");
  const [addEmail, setAddEmail] = useState("");
  const [showAddForm, setShowAddForm] = useState(false);

  // Contact Picker API
  const hasContactPickerAPI = typeof navigator !== "undefined" && "contacts" in navigator;
  const [pickedContacts, setPickedContacts] = useState<Array<{ name: string; tel: string }>>([]);
  const [showPickedList, setShowPickedList] = useState(false);

  const openContactPicker = async () => {
    if (typeof navigator === "undefined" || !("contacts" in navigator)) {
      setShowAddForm(true);
      return;
    }
    try {
      const contacts = await (navigator as any).contacts.select(["name", "tel"], { multiple: true });
      const valid: Array<{ name: string; tel: string }> = contacts.flatMap((c: any) => {
        const name: string = c.name?.[0] ?? "";
        return ((c.tel ?? []) as string[]).map((tel) => ({ name, tel: tel.trim() }));
      }).filter((c: { name: string; tel: string }) => c.tel);
      if (valid.length === 0) {
        toast({ title: t("no_phone_numbers_toast") });
        return;
      }
      setPickedContacts(valid);
      setShowPickedList(true);
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        toast({ title: t("contacts_access_error"), variant: "destructive" });
      }
    }
  };

  const bulkBlockMutation = useMutation({
    mutationFn: (contacts: Array<{ name: string; tel: string }>) =>
      Promise.all(contacts.map(c =>
        apiRequest("POST", "/api/blocked-contacts", { name: c.name, phoneNumber: c.tel })
      )),
    onSuccess: (_data, contacts) => {
      qc.invalidateQueries({ queryKey: ["/api/blocked-contacts"] });
      setPickedContacts([]);
      setShowPickedList(false);
      toast({ title: contacts.length === 1 ? t("contact_blocked_toast") : t("contacts_blocked_n").replace("{n}", String(contacts.length)) });
    },
    onError: () => {
      toast({ title: t("failed_to_block_contacts"), variant: "destructive" });
    },
  });

  const addContactMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/blocked-contacts", { name: addName, phoneNumber: addPhone, email: addEmail.trim() || undefined }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/blocked-contacts"] });
      setAddName("");
      setAddPhone("");
      setAddEmail("");
      setShowAddForm(false);
      toast({ title: t("contact_blocked_toast") });
    },
    onError: (err: any) => {
      toast({ title: t("failed_toast"), description: err?.message, variant: "destructive" });
    },
  });

  const removeContactMutation = useMutation({
    mutationFn: (id: string) => apiRequest("DELETE", `/api/blocked-contacts/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/blocked-contacts"] });
      toast({ title: t("contact_unblocked") });
    },
  });

  // ── Stripe checkout (extras) ──────────────────────────────────────────────
  const [checkoutLoading, setCheckoutLoading] = useState<string | null>(null);

  const startCheckout = async (itemId: string) => {
    setCheckoutLoading(itemId);
    try {
      const data = await apiRequest("POST", "/api/stripe/extras-checkout", { itemId }) as any;
      if (data?.url) window.location.href = data.url;
    } catch (err: any) {
      toast({ title: t("checkout_failed"), description: err?.message, variant: "destructive" });
    } finally {
      setCheckoutLoading(null);
    }
  };

  // ── Delete account ────────────────────────────────────────────────────────
  const handleDeleteConfirm = () => {
    setShowDeleteDialog(false);
    toast({
      title: t("account_deletion_title"),
      description: t("account_deletion_desc"),
    });
  };

  // ─────────────────────────────────────────────────────────────────────────
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
          <h1 className="font-serif text-xl font-bold">{t("settings")}</h1>
        </div>
      </div>

      {/* ── Scrollable content ── */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-lg mx-auto w-full pb-28">

          {/* ── 1. Account ── */}
          <SectionHeader title={t("account")} first />
          <SettingRow
            icon={isPaused
              ? <PlayCircle className="w-[18px] h-[18px] text-primary" />
              : <PauseCircle className="w-[18px] h-[18px] text-muted-foreground" />}
            label={isPaused ? t("reactivate_account") : t("pause_account")}
            description={isPaused ? t("profile_paused_desc") : t("pause_account_desc")}
            labelClass={isPaused ? "text-primary" : undefined}
            onPress={() => setShowPauseDialog(true)}
            testId="button-pause-account"
          />
          <SettingRow
            icon={<Trash2 className="w-[18px] h-[18px] text-destructive" />}
            label={t("delete_account")}
            labelClass="text-destructive"
            description={t("delete_account_desc")}
            onPress={() => setShowDeleteDialog(true)}
            testId="button-delete-account"
          />
          <SettingRow
            icon={<LogOut className="w-[18px] h-[18px] text-destructive" />}
            label={isLoggingOut ? t("logging_out") : t("log_out")}
            labelClass="text-destructive"
            onPress={() => logout()}
            showChevron={false}
            testId="button-settings-logout"
          />

          {/* ── 2. Profile & Visibility ── */}
          <SectionHeader title={t("profile_visibility")} />
          <SettingRow
            icon={<Eye className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("show_last_active")}
            description={t("show_last_active_desc")}
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
            label={t("selfie_verification")}
            description={profile?.photoVerified ? t("verified_badge") : t("get_verified")}
            labelClass={profile?.photoVerified ? "text-primary" : undefined}
            onPress={() => setActiveSheet("selfie")}
            testId="button-selfie-verification"
          />
          <SettingRow
            icon={<ShieldOff className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("block_list")}
            description={blockedContacts.length
              ? `${blockedContacts.length} ${t("block_list").toLowerCase()}`
              : t("block_list_manage") ?? "Manage who can't contact you"}
            onPress={() => setActiveSheet("blocklist")}
            testId="button-block-list"
          />
          <SettingRow
            icon={<Filter className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("comment_filter")}
            description={t("comment_filter_desc")}
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
          <SectionHeader title={t("ai_chat")} />
          <SettingRow
            icon={<Bot className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("ai_starters")}
            description={t("ai_starters_desc")}
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
            label={t("audio_transcripts")}
            description={t("audio_transcripts_desc")}
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
          <SectionHeader title={t("contact_security")} />
          <SettingRow
            icon={<Phone className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("phone_number")}
            description={profile?.phoneNumber || "Not added"}
            onPress={() => {
              setPhoneInput(profile?.phoneNumber || "");
              setShowPhoneDialog(true);
            }}
            testId="button-settings-phone"
          />
          <div className="px-4 py-3.5 border-b border-border/50">
            <div className="flex items-center gap-3 mb-2">
              <Mail className="w-[18px] h-[18px] text-muted-foreground shrink-0" />
              <p className="text-sm font-medium">{t("email_address")}</p>
            </div>
            <p
              className="text-xs text-muted-foreground pl-[30px]"
              data-testid="text-settings-email"
            >
              {profile?.email || user?.email || "Not added"}
            </p>
          </div>
          {/* Connected accounts */}
          <div className="px-4 py-4 border-b border-border/50">
            <div className="flex items-center gap-3 mb-3">
              <Lock className="w-[18px] h-[18px] text-muted-foreground shrink-0" />
              <p className="text-sm font-medium">{t("connected_accounts")}</p>
            </div>
            <div className="space-y-2.5 pl-[30px]">
              {identitiesLoading ? (
                <p className="text-xs text-muted-foreground">{t("loading")}</p>
              ) : (
                <>
                  <ConnectedAccountRow
                    provider="google"
                    label="Google"
                    connected={isConnected("google")}
                    loading={connectingProvider === "google"}
                    onConnect={() => handleConnectProvider("google")}
                    onDisconnect={() => handleDisconnectProvider("google")}
                  />
                  <ConnectedAccountRow
                    provider="apple"
                    label="Apple"
                    connected={isConnected("apple")}
                    loading={connectingProvider === "apple"}
                    onConnect={() => handleConnectProvider("apple")}
                    onDisconnect={() => handleDisconnectProvider("apple")}
                  />
                </>
              )}
            </div>
          </div>

          {/* ── 5. Notifications ── */}
          <SectionHeader title={t("notifications")} />
          <SettingRow
            icon={<Bell className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("push_notifications")}
            description={t("push_notif_desc")}
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
          <SectionHeader title={t("subscription")} />
          <SettingRow
            icon={<Crown className="w-[18px] h-[18px] text-primary" />}
            label={t("subscribe_lulou")}
            description={t("subscribe_lulou_desc")}
            onPress={() => setActiveSheet("extras")}
            testId="button-settings-subscribe"
          />

          {/* ── 7. Preferences ── */}
          <SectionHeader title={t("preferences")} />
          <SettingRow
            icon={<Globe className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("app_language")}
            value={language}
            onPress={() => setActiveSheet("language")}
            testId="button-settings-language"
          />
          <SettingRow
            icon={<Ruler className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("units_label")}
            value={units === "miles" ? t("miles_feet") : t("km_metres")}
            onPress={() => setActiveSheet("units")}
            testId="button-settings-units"
          />

          {/* ── 8. Legal & Safety ── */}
          <SectionHeader title={t("legal_safety")} />
          <SettingRow
            icon={<Shield className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("privacy_policy")}
            onPress={() => setActiveSheet("privacy")}
            testId="button-privacy-policy"
          />
          <SettingRow
            icon={<BookOpen className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("terms_of_service")}
            onPress={() => setActiveSheet("terms")}
            testId="button-terms-of-service"
          />
          <SettingRow
            icon={<Download className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("download_data")}
            onPress={() => setActiveSheet("download_data")}
            testId="button-download-data"
          />
          <SettingRow
            icon={<Heart className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("safe_dating")}
            onPress={() => setActiveSheet("safety")}
            testId="button-safe-dating"
          />
          <SettingRow
            icon={<Users className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("member_principles")}
            onPress={() => setActiveSheet("principles")}
            testId="button-member-principles"
          />
          <SettingRow
            icon={<FileText className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("licences")}
            onPress={() => setActiveSheet("licences")}
            testId="button-licences"
          />
          <SettingRow
            icon={<Lock className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("privacy_preferences")}
            onPress={() => setActiveSheet("privacy_prefs")}
            testId="button-privacy-preferences"
          />

          <p className="text-center text-xs text-muted-foreground/40 pt-8 pb-2 select-none">
            Lulou Dating · v1.0
          </p>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════════════════
          Sheets
      ══════════════════════════════════════════════════════════════════════ */}

      {/* ── Selfie verification sheet ── */}
      <Sheet open={activeSheet === "selfie"} onOpenChange={open => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="h-[90vh] flex flex-col p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="font-serif">Selfie Verification</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 pb-8 flex flex-col items-center justify-start gap-4 pt-5">
            {selfieStep === "idle" && (
              <div className="flex flex-col items-center gap-5 mt-4">
                <div className="w-24 h-24 rounded-full bg-muted flex items-center justify-center">
                  <Camera className="w-10 h-10 text-muted-foreground" />
                </div>
                {profile?.photoVerified ? (
                  <>
                    <div className="flex items-center gap-2 text-primary">
                      <CheckCircle2 className="w-5 h-5" />
                      <p className="font-medium">Already verified</p>
                    </div>
                    <p className="text-sm text-muted-foreground text-center max-w-xs">
                      Your profile shows a verified badge. You can re-verify to update your selfie.
                    </p>
                    <Button onClick={startCamera} variant="outline" data-testid="button-reverify-selfie">
                      Re-verify
                    </Button>
                  </>
                ) : (
                  <>
                    <p className="text-sm text-muted-foreground text-center max-w-xs">
                      Take a quick selfie to earn a verified badge on your profile. We just check you're a real person — no data stored.
                    </p>
                    <Button onClick={startCamera} data-testid="button-start-camera">
                      <Camera className="w-4 h-4 mr-2" />
                      Open camera
                    </Button>
                  </>
                )}
              </div>
            )}

            {selfieStep === "camera" && (
              <div className="w-full flex flex-col items-center gap-4">
                <div className="relative w-full max-w-sm aspect-square rounded-2xl overflow-hidden bg-black">
                  <video
                    ref={videoRef}
                    className="w-full h-full object-cover scale-x-[-1]"
                    autoPlay
                    playsInline
                    muted
                    data-testid="video-selfie-camera"
                  />
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div
                      className={`w-48 h-48 rounded-full border-[3px] transition-all duration-300 ${
                        faceAligned === true
                          ? "border-green-400 shadow-[0_0_20px_rgba(74,222,128,0.5)]"
                          : faceAligned === false
                          ? "border-red-400/80"
                          : "border-white/40"
                      }`}
                    />
                  </div>
                </div>
                <canvas ref={canvasRef} className="hidden" />
                <p
                  className={`text-xs text-center transition-colors duration-300 ${
                    faceAligned === true
                      ? "text-green-500"
                      : faceAligned === false
                      ? "text-red-400"
                      : "text-muted-foreground"
                  }`}
                  data-testid="text-face-alignment"
                >
                  {faceAligned === true
                    ? t("face_aligned_text")
                    : faceAligned === false
                    ? t("face_not_aligned")
                    : t("position_face")}
                </p>
                <div className="flex gap-3">
                  <Button variant="outline" onClick={() => { stopCamera(); setSelfieStep("idle"); }} data-testid="button-cancel-camera">
                    {t("cancel")}
                  </Button>
                  <Button
                    onClick={capturePhoto}
                    disabled={faceAligned !== true}
                    data-testid="button-capture-photo"
                  >
                    {t("take_photo")}
                  </Button>
                </div>
              </div>
            )}

            {(selfieStep === "preview" || selfieStep === "submitting") && capturedSelfie && (
              <div className="w-full flex flex-col items-center gap-4">
                <div className="w-full max-w-sm aspect-square rounded-2xl overflow-hidden bg-black">
                  <img
                    src={capturedSelfie}
                    alt="Captured selfie"
                    className="w-full h-full object-cover scale-x-[-1]"
                    data-testid="img-selfie-preview"
                  />
                </div>
                <p className="text-sm text-muted-foreground text-center">Looking good? Submit to get verified.</p>
                <div className="flex gap-3">
                  <Button variant="outline" onClick={retakePhoto} disabled={selfieStep === "submitting"} data-testid="button-retake-selfie">
                    Retake
                  </Button>
                  <Button onClick={submitSelfie} disabled={selfieStep === "submitting"} data-testid="button-submit-selfie">
                    {selfieStep === "submitting" ? "Verifying…" : "Submit & verify"}
                  </Button>
                </div>
              </div>
            )}

            {selfieStep === "done" && (
              <div className="flex flex-col items-center gap-5 mt-4">
                <div className="w-24 h-24 rounded-full bg-primary/10 flex items-center justify-center">
                  <CheckCircle2 className="w-10 h-10 text-primary" />
                </div>
                <p className="font-serif text-xl font-semibold">You're verified!</p>
                <p className="text-sm text-muted-foreground text-center max-w-xs">
                  Your profile now shows a verified badge for all your matches to see.
                </p>
                <Button onClick={() => setActiveSheet(null)} data-testid="button-selfie-done">
                  Done
                </Button>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Block list sheet ── */}
      <Sheet open={activeSheet === "blocklist"} onOpenChange={open => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="h-[85vh] flex flex-col p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="font-serif">Block List</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 pb-8 pt-4">
            <p className="text-sm text-muted-foreground mb-4">
              Blocked contacts can't find or message you. Add a phone number to block someone not yet on Lulou.
            </p>

            {blockedContacts.length === 0 && !showAddForm && (
              <div className="text-center py-10">
                <ShieldOff className="w-10 h-10 text-muted-foreground/40 mx-auto mb-3" />
                <p className="text-sm text-muted-foreground">No blocked contacts yet</p>
              </div>
            )}

            <div className="space-y-2 mb-4">
              {blockedContacts.map(contact => (
                <div
                  key={contact.id}
                  className="flex items-center gap-3 px-4 py-3 rounded-xl bg-muted/50"
                  data-testid={`row-blocked-contact-${contact.id}`}
                >
                  <div className="flex-1 min-w-0">
                    {contact.name && (
                      <p className="text-sm font-medium truncate">{contact.name}</p>
                    )}
                    {contact.phoneNumber && <p className="text-xs text-muted-foreground">{contact.phoneNumber}</p>}
                    {(contact as any).email && <p className="text-xs text-muted-foreground">{(contact as any).email}</p>}
                  </div>
                  <button
                    className="shrink-0 w-8 h-8 flex items-center justify-center rounded-full hover:bg-destructive/10 text-destructive transition-colors"
                    onClick={() => removeContactMutation.mutate(contact.id)}
                    disabled={removeContactMutation.isPending}
                    data-testid={`button-unblock-${contact.id}`}
                    aria-label="Unblock"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>

            {showPickedList ? (
              <div className="rounded-xl border border-border p-4 space-y-3">
                <p className="text-sm font-medium">Block these contacts?</p>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {pickedContacts.map((c, i) => (
                    <div key={i} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-muted/50 text-sm">
                      <div className="min-w-0">
                        {c.name && <p className="font-medium truncate">{c.name}</p>}
                        <p className="text-xs text-muted-foreground">{c.tel}</p>
                      </div>
                      <button
                        className="shrink-0 text-muted-foreground hover:text-destructive transition-colors"
                        onClick={() => setPickedContacts(prev => prev.filter((_, idx) => idx !== i))}
                        aria-label="Remove"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline" size="sm"
                    onClick={() => { setPickedContacts([]); setShowPickedList(false); }}
                    data-testid="button-cancel-picked-contacts"
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    disabled={pickedContacts.length === 0 || bulkBlockMutation.isPending}
                    onClick={() => bulkBlockMutation.mutate(pickedContacts)}
                    data-testid="button-confirm-block-contacts"
                  >
                    {bulkBlockMutation.isPending ? "Blocking…" : `Block ${pickedContacts.length}`}
                  </Button>
                </div>
              </div>
            ) : showAddForm ? (
              <div className="rounded-xl border border-border p-4 space-y-3">
                {!hasContactPickerAPI && (
                  <p className="text-xs text-muted-foreground">{t("block_no_support_msg")}</p>
                )}
                <p className="text-sm font-medium">Block a contact</p>
                <Input
                  placeholder="Name (optional)"
                  value={addName}
                  onChange={e => setAddName(e.target.value)}
                  data-testid="input-block-name"
                />
                <Input
                  placeholder="Phone number"
                  value={addPhone}
                  onChange={e => setAddPhone(e.target.value)}
                  type="tel"
                  data-testid="input-block-phone"
                />
                <Input
                  placeholder={t("block_email_label")}
                  value={addEmail}
                  onChange={e => setAddEmail(e.target.value)}
                  type="email"
                  data-testid="input-block-email"
                />
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => { setShowAddForm(false); setAddName(""); setAddPhone(""); setAddEmail(""); }}
                    data-testid="button-cancel-add-contact"
                  >
                    {t("cancel")}
                  </Button>
                  <Button
                    size="sm"
                    disabled={(!addPhone.trim() && !addEmail.trim()) || addContactMutation.isPending}
                    onClick={() => addContactMutation.mutate()}
                    data-testid="button-save-blocked-contact"
                  >
                    {addContactMutation.isPending ? t("blocking_label") : t("block_action")}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-1 pt-1">
                <button
                  className="flex items-center gap-2 text-sm text-primary font-medium py-2"
                  onClick={openContactPicker}
                  data-testid="button-import-contacts"
                >
                  <Users className="w-4 h-4" />
                  {t("access_contacts")}
                </button>
                <button
                  className="flex items-center gap-2 text-sm text-primary font-medium py-2"
                  onClick={() => setShowAddForm(true)}
                  data-testid="button-add-blocked-contact"
                >
                  <Plus className="w-4 h-4" />
                  {t("add_manually")}
                </button>
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Subscribe / Extras sheet ── */}
      <Sheet open={activeSheet === "extras"} onOpenChange={open => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="h-[85vh] flex flex-col p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="font-serif">{t("lulou_extras")}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 pb-8 pt-4 space-y-4">
            {/* Membership */}
            <div className="rounded-2xl bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/20 p-5">
              <div className="flex items-center gap-2 mb-1">
                <Crown className="w-4 h-4 text-primary" />
                <p className="font-serif font-semibold text-base">{t("lulou_membership_title")}</p>
              </div>
              <p className="text-xs text-muted-foreground mb-4">
                {t("membership_unlock_desc")}
              </p>
              <Button
                className="w-full"
                disabled={checkoutLoading === "membership"}
                onClick={() => startCheckout("membership")}
                data-testid="button-subscribe-membership"
              >
                {checkoutLoading === "membership" ? t("opening_label") : t("join_membership")}
              </Button>
            </div>

            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/65 pt-2">
              {t("a_la_carte")}
            </p>

            <ExtrasItem
              title={t("extras_messages5_title")}
              description={t("extras_messages5_desc")}
              price="$4.99"
              itemId="messages-5"
              loading={checkoutLoading === "messages-5"}
              onBuy={() => startCheckout("messages-5")}
            />
            <ExtrasItem
              title={t("extras_undo_close_title")}
              description={t("extras_undo_close_desc")}
              price="$2.99"
              itemId="undo-close"
              loading={checkoutLoading === "undo-close"}
              onBuy={() => startCheckout("undo-close")}
            />

            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/65 pt-2">
              Call Credit Packs
            </p>

            <ExtrasItem
              title={t("extras_starter_pack_title")}
              description={t("extras_starter_pack_desc")}
              price="$4.99"
              itemId="starter-pack"
              loading={checkoutLoading === "starter-pack"}
              onBuy={() => startCheckout("starter-pack")}
            />
            <ExtrasItem
              title={t("extras_connection_pack_title")}
              description={t("extras_connection_pack_desc")}
              price="$12.99"
              itemId="connection-pack"
              loading={checkoutLoading === "connection-pack"}
              onBuy={() => startCheckout("connection-pack")}
            />
            <ExtrasItem
              title={t("extras_premium_pack_title")}
              description={t("extras_premium_pack_desc")}
              price="$19.99"
              itemId="premium-pack"
              loading={checkoutLoading === "premium-pack"}
              onBuy={() => startCheckout("premium-pack")}
            />
            <ExtrasItem
              title={t("extras_chemistry_pack_title")}
              description={t("extras_chemistry_pack_desc")}
              price="$16.99"
              itemId="chemistry-pack"
              loading={checkoutLoading === "chemistry-pack"}
              onBuy={() => startCheckout("chemistry-pack")}
            />
            <ExtrasItem
              title={t("extras_deep_conn_pack_title")}
              description={t("extras_deep_conn_pack_desc")}
              price="$27.99"
              itemId="deep-connection-pack"
              loading={checkoutLoading === "deep-connection-pack"}
              onBuy={() => startCheckout("deep-connection-pack")}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Language sheet ── */}
      <Sheet open={activeSheet === "language"} onOpenChange={open => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="h-[80vh] flex flex-col p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="font-serif">{t("app_language")}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto py-2">
            {LANGUAGES.map(lang => (
              <button
                key={lang}
                className="w-full px-5 py-3.5 flex items-center justify-between text-left hover:bg-muted/50 transition-colors border-b border-border/40"
                onClick={() => { setLanguage(lang); setActiveSheet(null); }}
                data-testid={`button-language-${lang.toLowerCase().replace(/\s/g, "-")}`}
              >
                <span className="text-sm">{lang}</span>
                {language === lang && (
                  <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                )}
              </button>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Units sheet ── */}
      <Sheet open={activeSheet === "units"} onOpenChange={open => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="font-serif">{t("units_label")}</SheetTitle>
          </SheetHeader>
          <div className="py-2">
            {(["miles", "km"] as const).map(u => (
              <button
                key={u}
                className="w-full px-5 py-4 flex items-center justify-between text-left hover:bg-muted/50 transition-colors border-b border-border/40"
                onClick={() => { setUnits(u); setActiveSheet(null); }}
                data-testid={`button-units-${u}`}
              >
                <div>
                  <p className="text-sm font-medium">
                    {u === "miles" ? t("imperial") : t("metric")}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {u === "miles" ? t("miles_feet") : t("km_metres")}
                  </p>
                </div>
                {units === u && (
                  <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                )}
              </button>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Privacy Policy sheet ── */}
      <Sheet open={activeSheet === "privacy"} onOpenChange={open => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="h-[90vh] flex flex-col p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="font-serif">{t("privacy_policy")}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 pb-10 pt-5 space-y-5 text-sm text-muted-foreground leading-relaxed">
            <p className="text-base font-semibold text-foreground">{t("pp_updated")}</p>
            <section>
              <h3 className="font-semibold text-foreground mb-2">{t("pp_s1_title")}</h3>
              <p>{t("pp_s1_body")}</p>
            </section>
            <section>
              <h3 className="font-semibold text-foreground mb-2">{t("pp_s2_title")}</h3>
              <p>{t("pp_s2_body")}</p>
            </section>
            <section>
              <h3 className="font-semibold text-foreground mb-2">{t("pp_s3_title")}</h3>
              <p>{t("pp_s3_body")}</p>
            </section>
            <section>
              <h3 className="font-semibold text-foreground mb-2">{t("pp_s4_title")}</h3>
              <p>{t("pp_s4_body")}</p>
            </section>
            <section>
              <h3 className="font-semibold text-foreground mb-2">{t("pp_s5_title")}</h3>
              <p>{t("pp_s5_body")}</p>
            </section>
            <section>
              <h3 className="font-semibold text-foreground mb-2">{t("pp_s6_title")}</h3>
              <p>{t("pp_s6_body")}</p>
            </section>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Terms of Service sheet ── */}
      <Sheet open={activeSheet === "terms"} onOpenChange={open => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="h-[90vh] flex flex-col p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="font-serif">{t("terms_of_service")}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 pb-10 pt-5 space-y-5 text-sm text-muted-foreground leading-relaxed">
            <p className="text-base font-semibold text-foreground">{t("pp_updated")}</p>
            <section>
              <h3 className="font-semibold text-foreground mb-2">{t("tos_s1_title")}</h3>
              <p>{t("tos_s1_body")}</p>
            </section>
            <section>
              <h3 className="font-semibold text-foreground mb-2">{t("tos_s2_title")}</h3>
              <p>{t("tos_s2_body")}</p>
            </section>
            <section>
              <h3 className="font-semibold text-foreground mb-2">{t("tos_s3_title")}</h3>
              <p>{t("tos_s3_body")}</p>
            </section>
            <section>
              <h3 className="font-semibold text-foreground mb-2">{t("tos_s4_title")}</h3>
              <p>{t("tos_s4_body")}</p>
            </section>
            <section>
              <h3 className="font-semibold text-foreground mb-2">{t("tos_s5_title")}</h3>
              <p>{t("tos_s5_body")}</p>
            </section>
            <section>
              <h3 className="font-semibold text-foreground mb-2">{t("tos_s6_title")}</h3>
              <p>{t("tos_s6_body")}</p>
            </section>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Download My Data sheet ── */}
      <Sheet open={activeSheet === "download_data"} onOpenChange={open => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="h-[60vh] flex flex-col p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="font-serif">{t("download_data")}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 pb-8 pt-5 flex flex-col items-center gap-5 text-center">
            <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mt-4">
              <Download className="w-7 h-7 text-primary" />
            </div>
            <div className="space-y-2 max-w-xs">
              <p className="font-medium">{t("export_data_title")}</p>
              <p className="text-sm text-muted-foreground">
                {t("export_data_desc")}
              </p>
            </div>
            <Button
              onClick={async () => {
                setIsExporting(true);
                try {
                  const token = (await supabase.auth.getSession()).data.session?.access_token;
                  const res = await fetch("/api/profile/export", {
                    headers: { Authorization: `Bearer ${token}` },
                  });
                  if (!res.ok) throw new Error("Export failed");
                  const data = await res.json();
                  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `lulou-data-${new Date().toISOString().slice(0, 10)}.json`;
                  a.click();
                  URL.revokeObjectURL(url);
                  toast({ title: t("download_complete") });
                } catch {
                  toast({ title: t("export_failed"), variant: "destructive" });
                } finally {
                  setIsExporting(false);
                }
              }}
              disabled={isExporting}
              data-testid="button-export-data"
            >
              {isExporting ? t("preparing_download") : t("download_data")}
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Safe Dating Tips sheet ── */}
      <Sheet open={activeSheet === "safety"} onOpenChange={open => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="h-[90vh] flex flex-col p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="font-serif">{t("safe_dating")}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 pb-10 pt-5 space-y-4">
            {[
              { emoji: "📞", titleKey: "tip_voice_call_title", bodyKey: "tip_voice_call_body" },
              { emoji: "🚩", titleKey: "tip_red_flags_title",  bodyKey: "tip_red_flags_body" },
              { emoji: "📍", titleKey: "tip_public_title",     bodyKey: "tip_public_body" },
              { emoji: "🚗", titleKey: "tip_transport_title",  bodyKey: "tip_transport_body" },
              { emoji: "📱", titleKey: "tip_share_plans_title",bodyKey: "tip_share_plans_body" },
              { emoji: "🍹", titleKey: "tip_drinks_title",     bodyKey: "tip_drinks_body" },
              { emoji: "🚫", titleKey: "tip_financial_title",  bodyKey: "tip_financial_body" },
              { emoji: "🆘", titleKey: "tip_emergency_title",  bodyKey: "tip_emergency_body" },
            ].map(tip => (
              <div key={tip.titleKey} className="flex gap-3 p-4 rounded-xl bg-muted/40">
                <span className="text-2xl shrink-0 mt-0.5">{tip.emoji}</span>
                <div>
                  <p className="font-medium text-sm mb-0.5">{t(tip.titleKey as any)}</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{t(tip.bodyKey as any)}</p>
                </div>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Member Principles sheet ── */}
      <Sheet open={activeSheet === "principles"} onOpenChange={open => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="h-[90vh] flex flex-col p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="font-serif">{t("member_principles")}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 pb-10 pt-5 space-y-4">
            <p className="text-sm text-muted-foreground">{t("mp_intro")}</p>
            {[
              { num: "01", titleKey: "mp_01_title", bodyKey: "mp_01_body" },
              { num: "02", titleKey: "mp_02_title", bodyKey: "mp_02_body" },
              { num: "03", titleKey: "mp_03_title", bodyKey: "mp_03_body" },
              { num: "04", titleKey: "mp_04_title", bodyKey: "mp_04_body" },
              { num: "05", titleKey: "mp_05_title", bodyKey: "mp_05_body" },
              { num: "06", titleKey: "mp_06_title", bodyKey: "mp_06_body" },
              { num: "07", titleKey: "mp_07_title", bodyKey: "mp_07_body" },
            ].map(p => (
              <div key={p.num} className="flex gap-4 p-4 rounded-xl bg-muted/40">
                <span className="font-serif text-2xl font-bold text-primary/40 shrink-0 leading-none mt-0.5">{p.num}</span>
                <div>
                  <p className="font-medium text-sm mb-0.5">{t(p.titleKey as any)}</p>
                  <p className="text-xs text-muted-foreground leading-relaxed">{t(p.bodyKey as any)}</p>
                </div>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={activeSheet === "licences"} onOpenChange={open => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="h-[90vh] flex flex-col p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="font-serif">{t("licences")}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 pb-10 pt-5 space-y-6">
            <p className="text-sm text-muted-foreground">{t("lic_intro")}</p>
            {[
              { name: "React",                   licence: "MIT",        descKey: "lib_react_desc" },
              { name: "Vite",                    licence: "MIT",        descKey: "lib_vite_desc" },
              { name: "Tailwind CSS",            licence: "MIT",        descKey: "lib_tailwind_desc" },
              { name: "Radix UI / shadcn/ui",    licence: "MIT",        descKey: "lib_radix_desc" },
              { name: "Express",                 licence: "MIT",        descKey: "lib_express_desc" },
              { name: "Supabase",                licence: "Apache 2.0", descKey: "lib_supabase_desc" },
              { name: "Drizzle ORM",             licence: "Apache 2.0", descKey: "lib_drizzle_desc" },
              { name: "TanStack Query",          licence: "MIT",        descKey: "lib_tanstack_desc" },
              { name: "Lucide Icons",            licence: "ISC",        descKey: "lib_lucide_desc" },
              { name: "Wouter",                  licence: "ISC",        descKey: "lib_wouter_desc" },
              { name: "Zod",                     licence: "MIT",        descKey: "lib_zod_desc" },
              { name: "WebRTC (browser native)", licence: "W3C / IETF", descKey: "lib_webrtc_desc" },
            ].map(lib => (
              <div key={lib.name} className="border-b border-border/50 pb-4 last:border-0">
                <div className="flex items-center justify-between mb-0.5">
                  <p className="font-medium text-sm">{lib.name}</p>
                  <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full">{lib.licence}</span>
                </div>
                <p className="text-xs text-muted-foreground">{t(lib.descKey as any)}</p>
              </div>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      <Sheet open={activeSheet === "privacy_prefs"} onOpenChange={open => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="h-[90vh] flex flex-col p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="font-serif">{t("privacy_preferences")}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 pb-10 pt-5 space-y-6">
            <p className="text-sm text-muted-foreground">{t("pprefs_intro")}</p>
            {[
              { titleKey: "pprefs_1_title", descKey: "pprefs_1_desc", required: true },
              { titleKey: "pprefs_2_title", descKey: "pprefs_2_desc", required: true },
              { titleKey: "pprefs_3_title", descKey: "pprefs_3_desc", required: true },
              { titleKey: "pprefs_4_title", descKey: "pprefs_4_desc", required: false },
              { titleKey: "pprefs_5_title", descKey: "pprefs_5_desc", required: false },
            ].map(item => (
              <div key={item.titleKey} className="flex gap-4 p-4 rounded-xl bg-muted/30 border border-border/40">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-medium text-sm">{t(item.titleKey as any)}</p>
                    {item.required && (
                      <span className="text-[10px] uppercase tracking-wide text-primary/70 font-semibold bg-primary/10 px-1.5 py-0.5 rounded-full">{t("required_label")}</span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{t(item.descKey as any)}</p>
                </div>
              </div>
            ))}
            <p className="text-xs text-muted-foreground/60 pt-2">{t("pprefs_footer")}</p>
          </div>
        </SheetContent>
      </Sheet>

      {/* ══════════════════════════════════════════════════════════════════════
          Dialogs
      ══════════════════════════════════════════════════════════════════════ */}

      {/* Phone number dialog */}
      <Dialog open={showPhoneDialog} onOpenChange={setShowPhoneDialog}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="font-serif">{t("edit_phone_title")}</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <Input
              type="tel"
              placeholder="+1 (555) 000-0000"
              value={phoneInput}
              onChange={e => setPhoneInput(e.target.value)}
              data-testid="input-phone-number"
            />
            <p className="text-xs text-muted-foreground mt-2">
              {t("phone_privacy_note")}
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPhoneDialog(false)} data-testid="button-phone-cancel">
              {t("cancel")}
            </Button>
            <Button
              disabled={phoneMutation.isPending}
              onClick={() => phoneMutation.mutate(phoneInput.trim())}
              data-testid="button-phone-save"
            >
              {phoneMutation.isPending ? t("saving_msg") : t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("delete_account_title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("delete_account_dialog_desc")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-delete-cancel">{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              data-testid="button-delete-confirm"
            >
              {t("delete_account_confirm_btn")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Pause / Unpause confirmation */}
      <AlertDialog open={showPauseDialog} onOpenChange={setShowPauseDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {isPaused ? "Reactivate your account?" : "Pause your account?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {isPaused
                ? "Your profile will become visible in discovery again. Your existing matches and conversations stay exactly as they are."
                : "Your profile will be hidden from discovery. Your matches and conversations stay safe. You can reactivate anytime."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-pause-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handlePauseConfirm}
              disabled={pauseMutation.isPending}
              data-testid="button-pause-confirm"
            >
              {pauseMutation.isPending
                ? "Saving…"
                : isPaused
                  ? "Reactivate"
                  : "Pause account"}
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

function ConnectedAccountRow({
  provider,
  label,
  connected,
  loading,
  onConnect,
  onDisconnect,
}: {
  provider: string;
  label: string;
  connected: boolean;
  loading?: boolean;
  onConnect: () => void;
  onDisconnect: () => void;
}) {
  const { t } = useLanguageContext();
  return (
    <div className="flex items-center justify-between">
      <p className="text-sm text-muted-foreground">{label}</p>
      <button
        disabled={loading}
        className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full transition-colors disabled:opacity-60 disabled:cursor-not-allowed ${
          connected
            ? "bg-primary/10 text-primary hover:bg-primary/20"
            : "bg-muted text-muted-foreground hover:bg-muted/80"
        }`}
        onClick={connected ? onDisconnect : onConnect}
        data-testid={`button-${connected ? "disconnect" : "connect"}-${provider}`}
      >
        {loading
          ? <><span className="w-3 h-3 border border-current border-t-transparent rounded-full animate-spin inline-block" /></>
          : connected
            ? <><Link2Off className="w-3 h-3" /> {t("disconnect_btn")}</>
            : <><Link className="w-3 h-3" /> {t("connect_btn")}</>}
      </button>
    </div>
  );
}

function ExtrasItem({
  title,
  description,
  price,
  itemId,
  loading,
  onBuy,
}: {
  title: string;
  description: string;
  price: string;
  itemId: string;
  loading: boolean;
  onBuy: () => void;
}) {
  return (
    <div className="flex items-center gap-3 p-4 rounded-xl border border-border/60">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
      </div>
      <Button
        size="sm"
        variant="outline"
        disabled={loading}
        onClick={onBuy}
        data-testid={`button-buy-${itemId}`}
      >
        {loading ? "…" : price}
      </Button>
    </div>
  );
}
