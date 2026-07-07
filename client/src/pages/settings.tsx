import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { startPurchase, restorePurchases as doRestorePurchases } from "@/lib/purchase-service";
import { supabase } from "@/lib/supabase";
import { useUnits } from "@/lib/units";
import { usePushNotifications } from "@/hooks/use-push-notifications";
import type { NotifCategory } from "@/hooks/use-push-notifications";
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
  Video,
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
  Mic,
  CreditCard,
  Cookie,
} from "lucide-react";
import type { Profile, BlockedContact } from "@shared/schema";
import { useLanguageContext } from "@/contexts/language-context";
import { LulouGuidePreview } from "@/components/lulou-guide";
import { GUIDE_KEYS, resetGuide } from "@/lib/guide-store";

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


type ActiveSheet = "selfie" | "blocklist" | "extras" | "language" | "units" | "privacy" | "terms" | "download_data" | "safety" | "principles" | "licences" | "privacy_prefs" | "data_deletion" | "cookie_policy" | "billing_terms" | "lulou_guide" | null;

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

  // Sync all three settings from server profile on initial load (overrides stale localStorage).
  useEffect(() => {
    if (!profile) return;
    if (profile.showLastActive !== undefined && profile.showLastActive !== null) {
      setShowLastActive(profile.showLastActive);
    }
    if ((profile as any).commentFilter !== undefined && (profile as any).commentFilter !== null) {
      setCommentFilter((profile as any).commentFilter);
    }
    if ((profile as any).conversationStarterAi !== undefined && (profile as any).conversationStarterAi !== null) {
      setAiStarters((profile as any).conversationStarterAi);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.userId]);

  // Save settings to server whenever they change.
  useEffect(() => {
    if (!user) return;
    apiRequest("POST", "/api/profile", { showLastActive }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showLastActive]);
  useEffect(() => {
    if (!user) return;
    apiRequest("POST", "/api/profile", { commentFilter }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [commentFilter]);
  useEffect(() => {
    if (!user) return;
    apiRequest("POST", "/api/profile", { conversationStarterAi: aiStarters }).catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aiStarters]);
  const [audioTranscripts,  setAudioTranscripts]  = useToggle("audio_transcripts", false);
  const {
    isSupported:        pushSupported,
    isIosSafari:        pushIsIosSafari,
    permission:         pushPermission,
    isSubscribed:       pushSubscribed,
    preferences:        pushPrefs,
    isLoading:          pushLoading,
    error:              pushError,
    debugStep:          pushDebugStep,
    subscribe:          pushSubscribeRaw,
    unsubscribe:        pushUnsubscribeRaw,
    updatePreference:   updatePushPref,
  } = usePushNotifications();

  // Show any push error as a toast
  useEffect(() => {
    if (pushError) {
      toast({ title: "Notifications", description: pushError, variant: "destructive" });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushError]);

  const pushSubscribe = useCallback(async () => {
    const onStep = (step: string) => {
      // Toast only key milestones so the user isn't spammed — full trace in console
      if (step.startsWith("Step 2") || step.startsWith("Step 4") || step.startsWith("Step 5") || step.startsWith("FAIL") || step.startsWith("Done")) {
        toast({ title: "Notifications", description: step, duration: 4000 });
      }
    };
    const ok = await pushSubscribeRaw(onStep);
    if (ok) toast({ title: "✓ Notifications enabled", description: "You'll receive push notifications on this device." });
  }, [pushSubscribeRaw]);

  const pushUnsubscribe = useCallback(async () => {
    await pushUnsubscribeRaw();
    toast({ title: "Notifications disabled" });
  }, [pushUnsubscribeRaw]);

  const PUSH_CATS: Array<{ key: NotifCategory; label: string; Icon: typeof Heart }> = [
    { key: "newMatch"     as NotifCategory, label: "Matches",       Icon: Heart      },
    { key: "newLike"      as NotifCategory, label: "Likes",         Icon: Eye        },
    { key: "newMessage"   as NotifCategory, label: "Messages",      Icon: Mail       },
    { key: "incomingCall" as NotifCategory, label: "Calls",         Icon: Phone      },
    { key: "payment"      as NotifCategory, label: "Purchases",     Icon: CreditCard },
    { key: "safety"       as NotifCategory, label: "Safety alerts", Icon: Shield     },
  ];

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
  const [restoreLoading, setRestoreLoading] = useState(false);

  const restorePurchases = () => {
    void doRestorePurchases({
      onLoading: setRestoreLoading,
      onComplete: (count, names) => {
        if (count > 0) {
          toast({ title: `${count} purchase${count === 1 ? "" : "s"} restored`, description: names.join(", ") });
        } else {
          toast({ title: "All purchases already applied", description: "Nothing new to restore." });
        }
      },
      onError: (msg) => toast({ title: "Restore failed", description: msg, variant: "destructive" }),
    });
  };

  const startCheckout = (itemId: string) => {
    setCheckoutLoading(itemId);
    void startPurchase({
      productId: itemId,
      body: { itemId },
      onError: (msg) => {
        toast({ title: t("checkout_failed"), description: msg, variant: "destructive" });
        setCheckoutLoading(null);
      },
    });
  };

  // ── Membership status ─────────────────────────────────────────────────────
  const { data: membershipStatus } = useQuery<{
    active: boolean;
    status: string | null;
    currentPeriodEnd: string | null;
  }>({ queryKey: ["/api/membership/status"] });

  const [portalLoading, setPortalLoading] = useState(false);
  const openStripePortal = async () => {
    setPortalLoading(true);
    try {
      const res = await apiRequest("POST", "/api/stripe/create-portal-session", {});
      const data = await res.json();
      if (data?.url) window.location.href = data.url;
    } catch (err: any) {
      toast({ title: "Failed to open billing portal", description: err?.message, variant: "destructive" });
    } finally {
      setPortalLoading(false);
    }
  };

  // ── Version / deployment proof ────────────────────────────────────────────
  const { data: healthData } = useQuery<{
    commitHash?: string; env?: string; startedAt?: string; ts?: string;
  }>({ queryKey: ["/api/health"], staleTime: 30_000, refetchOnWindowFocus: false });

  const [swVersion, setSwVersion] = useState<string>("querying…");
  useEffect(() => {
    if (!("serviceWorker" in navigator)) { setSwVersion("not supported"); return; }
    navigator.serviceWorker.ready.then(reg => {
      if (!reg.active) { setSwVersion("inactive"); return; }
      const mc = new MessageChannel();
      const timer = setTimeout(() => setSwVersion("timeout"), 3000);
      mc.port1.onmessage = (e) => {
        clearTimeout(timer);
        if (e.data?.type === "VERSION") setSwVersion(e.data.version);
      };
      reg.active.postMessage({ type: "GET_VERSION" }, [mc.port2]);
    }).catch(() => setSwVersion("error"));
  }, []);

  const [isResetting, setIsResetting] = useState(false);
  const handleResetCache = async () => {
    setIsResetting(true);
    try {
      if ("serviceWorker" in navigator) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
      if ("caches" in window) {
        const cacheKeys = await caches.keys();
        await Promise.all(cacheKeys.map(k => caches.delete(k)));
      }
      window.location.reload();
    } catch (err: any) {
      setIsResetting(false);
      toast({ title: "Reset failed", description: err?.message, variant: "destructive" });
    }
  };

  // ── Delete account ────────────────────────────────────────────────────────
  const [isDeleting, setIsDeleting] = useState(false);

  const handleDeleteConfirm = async () => {
    setIsDeleting(true);
    try {
      await apiRequest("DELETE", "/api/account", undefined);
      await supabase.auth.signOut();
      navigate("/auth");
    } catch (err: any) {
      setIsDeleting(false);
      setShowDeleteDialog(false);
      toast({
        title: "Deletion failed",
        description: err?.message ?? "Please try again or contact support@lulou.dating",
        variant: "destructive",
      });
    }
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
            <ArrowLeft className="w-5 h-5 rtl:rotate-180" />
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

          {/* ── 2. Membership ── */}
          {membershipStatus?.active && (
            <>
              <SectionHeader title={t("membership_label")} />
              <div className="mx-4 mb-1 p-4 rounded-xl bg-primary/5 border border-primary/20">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center gap-2">
                    <Crown className="w-4 h-4 text-primary" />
                    <span className="text-sm font-semibold text-primary">{t("lulou_member_label")}</span>
                  </div>
                  <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-primary/15 text-primary capitalize">
                    {membershipStatus.status ?? "active"}
                  </span>
                </div>
                {membershipStatus.currentPeriodEnd && (
                  <p className="text-xs text-muted-foreground mb-3">
                    Renews {new Date(membershipStatus.currentPeriodEnd).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}
                  </p>
                )}
                <button
                  onClick={openStripePortal}
                  disabled={portalLoading}
                  className="w-full text-sm font-medium py-2 px-4 rounded-lg border border-primary/30 text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                  data-testid="button-manage-membership"
                >
                  {portalLoading ? "Opening…" : "Manage Subscription"}
                </button>
              </div>
            </>
          )}

          {/* ── 3. Profile & Visibility ── */}
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

          {/* ── 4. Lulou Guide ── */}
          <SectionHeader title={t("lulou_guide_label")} />
          <SettingRow
            icon={<BookOpen className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("replay_guides_label")}
            description={t("replay_guides_desc")}
            onPress={() => setActiveSheet("lulou_guide")}
            testId="button-lulou-guide"
          />

          {/* ── 5. Contact & Security ── */}
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
              className="text-xs text-muted-foreground ps-[30px]"
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
            <div className="space-y-2.5 ps-[30px]">
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
          {pushIsIosSafari ? (
            <SettingRow
              icon={<Bell className="w-[18px] h-[18px] text-muted-foreground" />}
              label={t("push_notifications")}
              description="Push notifications only work after adding Lulou to your Home Screen. Tap the Share button → Add to Home Screen, then reopen the app."
              showChevron={false}
              testId="row-push-ios-safari"
            />
          ) : !pushSupported ? (
            <SettingRow
              icon={<Bell className="w-[18px] h-[18px] text-muted-foreground" />}
              label={t("push_notifications")}
              description="Push notifications are not supported on this device or browser."
              showChevron={false}
              testId="row-push-not-supported"
            />
          ) : pushPermission === "denied" ? (
            <SettingRow
              icon={<Bell className="w-[18px] h-[18px] text-muted-foreground" />}
              label={t("push_notifications")}
              description="Notifications are blocked. Go to iPhone Settings → Notifications → Lulou and turn on Allow Notifications."
              showChevron={false}
              testId="row-push-denied"
            />
          ) : (
            <>
              <SettingRow
                icon={<Bell className="w-[18px] h-[18px] text-muted-foreground" />}
                label={t("push_notifications")}
                description={
                  pushLoading && pushDebugStep
                    ? pushDebugStep
                    : pushSubscribed
                      ? t("push_notif_desc")
                      : "Tap to enable push notifications on this device"
                }
                trailing={
                  pushLoading ? (
                    <span className="text-xs text-muted-foreground px-2 animate-pulse">…</span>
                  ) : (
                    <Switch
                      checked={pushSubscribed}
                      onCheckedChange={(v) => v ? pushSubscribe() : pushUnsubscribe()}
                      data-testid="switch-push-notifications"
                    />
                  )
                }
                showChevron={false}
                testId="row-push-notifications"
              />
              {pushSubscribed && PUSH_CATS.map(({ key, label, Icon }) => (
                <SettingRow
                  key={key}
                  icon={<Icon className="w-[18px] h-[18px] text-muted-foreground" />}
                  label={label}
                  trailing={
                    <Switch
                      checked={pushPrefs[key] !== false}
                      onCheckedChange={(v) => updatePushPref(key, v)}
                      data-testid={`switch-notif-${key}`}
                    />
                  }
                  showChevron={false}
                  testId={`row-notif-${key}`}
                />
              ))}
            </>
          )}

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
          <SettingRow
            icon={<Trash2 className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("data_deletion_policy")}
            onPress={() => setActiveSheet("data_deletion")}
            testId="button-data-deletion"
          />
          <SettingRow
            icon={<Cookie className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("cookie_tracking_policy")}
            onPress={() => setActiveSheet("cookie_policy")}
            testId="button-cookie-policy"
          />
          <SettingRow
            icon={<CreditCard className="w-[18px] h-[18px] text-muted-foreground" />}
            label={t("billing_terms")}
            onPress={() => setActiveSheet("billing_terms")}
            testId="button-billing-terms"
          />

          {/* ── 9. Version / Deployment ── */}
          <SectionHeader title="About" />

          {/* Version info panel */}
          <div className="mx-4 mb-3 rounded-2xl bg-muted/40 border border-border/50 overflow-hidden">
            {/* Frontend row */}
            <div className="flex items-start justify-between px-4 py-3 border-b border-border/30">
              <span className="text-xs text-muted-foreground font-medium">Frontend</span>
              <div className="text-right">
                <p className="text-xs font-mono font-semibold" data-testid="text-version-frontend-commit">
                  {__COMMIT_HASH__}
                </p>
                <p className="text-[10px] text-muted-foreground/60 font-mono" data-testid="text-version-build-time">
                  {new Date(__BUILD_TIME__).toLocaleString()}
                </p>
              </div>
            </div>
            {/* Service worker row */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
              <span className="text-xs text-muted-foreground font-medium">Service Worker</span>
              <span className="text-xs font-mono font-semibold" data-testid="text-version-sw">
                v{swVersion}
              </span>
            </div>
            {/* API URL row */}
            <div className="flex items-start justify-between px-4 py-3 border-b border-border/30">
              <span className="text-xs text-muted-foreground font-medium">API</span>
              <span className="text-[10px] font-mono text-muted-foreground max-w-[60%] text-right break-all" data-testid="text-version-api-url">
                {(import.meta.env.VITE_API_BASE_URL as string | undefined) || "(same origin)"}
              </span>
            </div>
            {/* Backend row */}
            <div className="flex items-start justify-between px-4 py-3 border-b border-border/30">
              <span className="text-xs text-muted-foreground font-medium">Backend commit</span>
              <span className="text-xs font-mono font-semibold" data-testid="text-version-backend-commit">
                {healthData?.commitHash ?? "…"}
              </span>
            </div>
            {/* Backend env row */}
            <div className="flex items-center justify-between px-4 py-3 border-b border-border/30">
              <span className="text-xs text-muted-foreground font-medium">Backend env</span>
              <span className="text-xs font-mono" data-testid="text-version-backend-env">
                {healthData?.env ?? "…"}
              </span>
            </div>
            {/* Server started row */}
            <div className="flex items-start justify-between px-4 py-3">
              <span className="text-xs text-muted-foreground font-medium">Server started</span>
              <span className="text-[10px] font-mono text-muted-foreground text-right" data-testid="text-version-server-started">
                {healthData?.startedAt ? new Date(healthData.startedAt).toLocaleString() : "…"}
              </span>
            </div>
          </div>

          {/* Reset App Cache */}
          <div className="mx-4 mb-6">
            <button
              onClick={handleResetCache}
              disabled={isResetting}
              data-testid="button-reset-app-cache"
              className="w-full py-3.5 px-4 rounded-2xl border border-destructive/30 text-destructive text-sm font-semibold hover:bg-destructive/5 active:scale-[0.98] transition-all disabled:opacity-50 flex items-center justify-center gap-2"
            >
              {isResetting ? (
                <>
                  <span className="w-4 h-4 rounded-full border-2 border-destructive border-t-transparent animate-spin" />
                  Resetting…
                </>
              ) : (
                "Reset App Cache"
              )}
            </button>
            <p className="text-center text-[11px] text-muted-foreground/50 mt-2 px-2">
              Unregisters the service worker, clears all caches, and reloads. Use this if notifications or the app feel stale.
            </p>
          </div>

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
                      <Camera className="w-4 h-4 me-2" />
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

      {/* ── Lulou Guide sheet ── */}
      <Sheet open={activeSheet === "lulou_guide"} onOpenChange={open => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="h-[90vh] flex flex-col p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="font-serif">Lulou Guide</SheetTitle>
            <p className="text-sm text-muted-foreground mt-0.5">Replay any guide from your journey.</p>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 pb-10 pt-5 space-y-6">
            {[
              { label: "Welcome", key: GUIDE_KEYS.WELCOME, icon: "✨", title: "Welcome to Lulou", body: "Take your time. Great connections aren't rushed." },
              { label: "Opening a profile", key: GUIDE_KEYS.DISCOVER_OPEN, icon: "❤️", title: "Nice choice", body: "Open means you're interested. If they open you too, you'll connect." },
              { label: "Closing a profile", key: GUIDE_KEYS.DISCOVER_CLOSE, icon: "🌙", title: "Changed your mind?", body: "Undo Close can bring someone back." },
              { label: "Undoing", key: GUIDE_KEYS.DISCOVER_UNDO, title: "Nothing is final.", body: "People can be rediscovered." },
              { label: "Your first match", key: GUIDE_KEYS.CONNECTIONS_FIRST_MATCH, icon: "✨", title: "You're connected", body: "Take your time. Conversations unlock calls together." },
              { label: "First message", key: GUIDE_KEYS.CHAT_FIRST_MESSAGE, title: "15 messages each", body: "Enough to spark chemistry before hearing their voice." },
              { label: "First call", key: GUIDE_KEYS.CALLS_FIRST_PHONE, icon: "📞", title: "Hear their voice.", body: "Your first call lasts 10 minutes. No pressure." },
              { label: "Video call", key: GUIDE_KEYS.CALLS_FIRST_VIDEO, icon: "✨", title: "Now you can be seen.", body: "Chemistry deserves more than text." },
              { label: "Intention Wheel", key: GUIDE_KEYS.WHEEL_ENTRY, icon: "✨", title: "Standouts", body: "Exceptional profiles chosen for quality and compatibility." },
              { label: "Elevate", key: GUIDE_KEYS.ELEVATE_SCREEN, title: "More visibility.", body: "Elevate places your profile in front of more compatible people." },
              { label: "Membership", key: GUIDE_KEYS.MEMBERSHIP_VIEW, title: "Lulou Member", body: "Unlimited access. Refined for those who are serious." },
            ].map(({ label, key, icon, title, body }) => (
              <div key={key} className="space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">{label}</p>
                <LulouGuidePreview icon={icon} title={title} body={body} />
                <button
                  onClick={() => { resetGuide(user?.id, key); }}
                  className="w-full text-xs font-semibold text-primary py-2 rounded-xl border border-primary/25 hover:bg-primary/5 active:scale-95 transition-all"
                  data-testid={`button-replay-guide-${key}`}
                >
                  {t("replay_guide_btn")}
                </button>
              </div>
            ))}
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
            <div className="rounded-2xl bg-gradient-to-br from-primary/10 to-primary/5 border border-primary/20 p-5 space-y-4">
              {/* Title */}
              <div className="flex items-center gap-2">
                <Crown className="w-4 h-4 text-primary" />
                <p className="font-serif font-semibold text-base">{t("lulou_membership_title")}</p>
              </div>

              {/* Monthly benefits list */}
              <div className="space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/65">
                  {t("membership_monthly_benefits")}
                </p>
                <ul className="space-y-2">
                  {([
                    t("perk_2_extensions"),
                    t("perk_3_phone_credits"),
                    t("perk_1_video_credit"),
                    t("perk_1_undo_close"),
                  ] as string[]).map(perk => (
                    <li key={perk} className="flex items-center gap-2.5 text-sm">
                      <span className="w-1.5 h-1.5 rounded-full bg-primary shrink-0" />
                      {perk}
                    </li>
                  ))}
                </ul>
              </div>

              {/* Footnotes */}
              <div className="space-y-0.5 border-t border-primary/10 pt-3">
                <p className="text-xs text-muted-foreground">{t("membership_refreshes")}</p>
                <p className="text-xs text-muted-foreground">{t("membership_credits_rollover")}</p>
              </div>

              {/* Price + CTA */}
              <div className="flex items-center justify-between gap-3">
                <div>
                  <span className="font-serif font-bold text-xl">$19.99</span>
                  <span className="text-xs text-muted-foreground">/month</span>
                </div>
                <Button
                  size="sm"
                  className="shrink-0 px-5"
                  disabled={checkoutLoading === "membership"}
                  onClick={() => startCheckout("membership")}
                  data-testid="button-subscribe-membership"
                >
                  {checkoutLoading === "membership" ? t("opening_label") : t("join_membership")}
                </Button>
              </div>
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
            <ExtrasItem
              title="Voice Notes Unlock"
              description="Send & receive voice messages in any chat"
              price="$4.99"
              itemId="voice-notes-unlock"
              loading={checkoutLoading === "voice-notes-unlock"}
              onBuy={() => startCheckout("voice-notes-unlock")}
            />

            <div className="flex items-center gap-3 pt-1">
              <div className="flex-1 h-px bg-border/40" />
              <div className="flex items-center gap-1.5">
                <Phone className="w-3 h-3 text-primary/60" />
                <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground/55">Call Credits</p>
              </div>
              <div className="flex-1 h-px bg-border/40" />
            </div>

            <div className="space-y-2.5">
              <CallPackItem
                title={t("extras_starter_pack_title")}
                phoneCredits={1} videoCredits={0}
                price="$4.99" itemId="starter-pack"
                loading={checkoutLoading === "starter-pack"}
                onBuy={() => startCheckout("starter-pack")}
              />
              <CallPackItem
                title="Video Call Starter"
                phoneCredits={0} videoCredits={1}
                price="$6.99" itemId="video-starter"
                loading={checkoutLoading === "video-starter"}
                onBuy={() => startCheckout("video-starter")}
              />
              <CallPackItem
                title={t("extras_connection_pack_title")}
                phoneCredits={3} videoCredits={0}
                price="$12.99" itemId="connection-pack"
                loading={checkoutLoading === "connection-pack"}
                onBuy={() => startCheckout("connection-pack")}
              />
              <CallPackItem
                title={t("extras_premium_pack_title")}
                phoneCredits={5} videoCredits={0}
                price="$19.99" itemId="premium-pack"
                loading={checkoutLoading === "premium-pack"}
                onBuy={() => startCheckout("premium-pack")}
                isBestValue
              />
              <CallPackItem
                title={t("extras_chemistry_pack_title")}
                phoneCredits={3} videoCredits={1}
                price="$16.99" itemId="chemistry-pack"
                loading={checkoutLoading === "chemistry-pack"}
                onBuy={() => startCheckout("chemistry-pack")}
              />
              <CallPackItem
                title={t("extras_deep_conn_pack_title")}
                phoneCredits={5} videoCredits={3}
                price="$27.99" itemId="deep-connection-pack"
                loading={checkoutLoading === "deep-connection-pack"}
                onBuy={() => startCheckout("deep-connection-pack")}
              />
            </div>

            {/* ── Restore Purchases ── */}
            <div className="pt-2 border-t border-border/30 mt-2">
              <button
                onClick={restorePurchases}
                disabled={restoreLoading}
                data-testid="button-restore-purchases"
                className="w-full py-3 text-sm text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {restoreLoading ? (
                  <>
                    <span className="w-3.5 h-3.5 rounded-full border-2 border-current border-t-transparent animate-spin shrink-0" />
                    Checking your purchases…
                  </>
                ) : (
                  "Restore Purchases"
                )}
              </button>
              <p className="text-center text-[11px] text-muted-foreground/50 pb-1">
                Re-applies any paid Halos or Voice Notes not yet credited to your account.
              </p>
            </div>
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
                className="w-full px-5 py-3.5 flex items-center justify-between text-start hover:bg-muted/50 transition-colors border-b border-border/40"
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
                className="w-full px-5 py-4 flex items-center justify-between text-start hover:bg-muted/50 transition-colors border-b border-border/40"
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
                  const res = await fetch("/api/account/export", {
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

      {/* ── Data Deletion Policy sheet ── */}
      <Sheet open={activeSheet === "data_deletion"} onOpenChange={open => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="h-[90vh] flex flex-col p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="font-serif">{t("data_deletion_policy")}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 pb-10 pt-5 space-y-5 text-sm text-muted-foreground leading-relaxed">
            {([
              { titleKey: "dd_s1_title", bodyKey: "dd_s1_body" },
              { titleKey: "dd_s2_title", bodyKey: "dd_s2_body" },
              { titleKey: "dd_s3_title", bodyKey: "dd_s3_body" },
              { titleKey: "dd_s4_title", bodyKey: "dd_s4_body" },
            ] as const).map(s => (
              <section key={s.titleKey}>
                <h3 className="font-semibold text-foreground mb-2">{t(s.titleKey as any)}</h3>
                <p>{t(s.bodyKey as any)}</p>
              </section>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Cookie & Tracking Policy sheet ── */}
      <Sheet open={activeSheet === "cookie_policy"} onOpenChange={open => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="h-[90vh] flex flex-col p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="font-serif">{t("cookie_tracking_policy")}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 pb-10 pt-5 space-y-5 text-sm text-muted-foreground leading-relaxed">
            {([
              { titleKey: "cp_s1_title", bodyKey: "cp_s1_body" },
              { titleKey: "cp_s2_title", bodyKey: "cp_s2_body" },
              { titleKey: "cp_s3_title", bodyKey: "cp_s3_body" },
              { titleKey: "cp_s4_title", bodyKey: "cp_s4_body" },
            ] as const).map(s => (
              <section key={s.titleKey}>
                <h3 className="font-semibold text-foreground mb-2">{t(s.titleKey as any)}</h3>
                <p>{t(s.bodyKey as any)}</p>
              </section>
            ))}
          </div>
        </SheetContent>
      </Sheet>

      {/* ── Subscription & Billing Terms sheet ── */}
      <Sheet open={activeSheet === "billing_terms"} onOpenChange={open => !open && setActiveSheet(null)}>
        <SheetContent side="bottom" className="h-[90vh] flex flex-col p-0">
          <SheetHeader className="px-5 pt-5 pb-3 border-b shrink-0">
            <SheetTitle className="font-serif">{t("billing_terms")}</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-5 pb-10 pt-5 space-y-5 text-sm text-muted-foreground leading-relaxed">
            {([
              { titleKey: "bt_s1_title", bodyKey: "bt_s1_body" },
              { titleKey: "bt_s2_title", bodyKey: "bt_s2_body" },
              { titleKey: "bt_s3_title", bodyKey: "bt_s3_body" },
              { titleKey: "bt_s4_title", bodyKey: "bt_s4_body" },
            ] as const).map(s => (
              <section key={s.titleKey}>
                <h3 className="font-semibold text-foreground mb-2">{t(s.titleKey as any)}</h3>
                <p>{t(s.bodyKey as any)}</p>
              </section>
            ))}
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
          <div className="py-2 space-y-2">
            <div
              className="flex overflow-hidden rounded-xl border border-input focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-0"
              style={{ background: "hsl(var(--background))" }}
            >
              <div className="flex items-center px-3 border-r border-input bg-muted/40 shrink-0 select-none">
                <span className="text-sm font-semibold text-muted-foreground">+61</span>
              </div>
              <input
                type="tel"
                inputMode="numeric"
                placeholder="412 345 678"
                value={phoneInput.startsWith("+61") ? phoneInput.slice(3) : phoneInput}
                onChange={e => {
                  const digits = e.target.value.replace(/\D/g, "").slice(0, 9);
                  setPhoneInput(digits ? "+61" + digits : "");
                }}
                className="flex-1 px-3 py-2.5 text-sm bg-transparent outline-none"
                data-testid="input-phone-number"
              />
            </div>
            <p className="text-xs text-muted-foreground">
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
            <AlertDialogCancel disabled={isDeleting} data-testid="button-delete-cancel">{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60"
              data-testid="button-delete-confirm"
            >
              {isDeleting ? "Deleting…" : t("delete_account_confirm_btn")}
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
        <span className="text-sm text-muted-foreground shrink-0 me-0.5">{value}</span>
      )}
      {trailing && (
        <span onClick={e => e.stopPropagation()}>{trailing}</span>
      )}
      {showChevron && !trailing && (
        <ChevronRight className="w-4 h-4 text-muted-foreground/40 shrink-0 rtl:rotate-180" />
      )}
    </>
  );

  const baseClass =
    "w-full px-4 py-3.5 flex items-center gap-3 border-b border-border/50 text-start";

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
    <div className="flex items-start gap-4 p-4 rounded-2xl border border-border/70 bg-card/50">
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold leading-tight">{title}</p>
        <p className="text-xs text-muted-foreground mt-1 leading-snug">{description}</p>
      </div>
      <div className="shrink-0 flex flex-col items-end gap-2 pt-0.5">
        <span className="text-sm font-bold tabular-nums">{price}</span>
        <Button
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={onBuy}
          className="h-7 text-xs px-3"
          data-testid={`button-buy-${itemId}`}
        >
          {loading ? "…" : "Buy"}
        </Button>
      </div>
    </div>
  );
}

function CallPackItem({
  title,
  phoneCredits,
  videoCredits,
  price,
  itemId,
  loading,
  onBuy,
  isBestValue,
}: {
  title: string;
  phoneCredits: number;
  videoCredits: number;
  price: string;
  itemId: string;
  loading: boolean;
  onBuy: () => void;
  isBestValue?: boolean;
}) {
  return (
    <div className={`relative rounded-2xl border p-4 transition-all ${
      isBestValue
        ? "border-primary/40 bg-gradient-to-br from-primary/[0.08] to-primary/[0.03] shadow-sm"
        : "border-border/60 bg-card/50"
    }`}>
      {isBestValue && (
        <span className="absolute -top-2.5 start-4 px-2.5 py-0.5 rounded-full bg-primary text-primary-foreground text-[9px] font-bold tracking-widest uppercase">
          Best Value
        </span>
      )}
      <div className="flex items-center gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-tight">{title}</p>
          <div className="flex items-center gap-3 mt-1.5">
            {phoneCredits > 0 && (
              <span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                <Phone className="w-3 h-3 text-primary/70" />
                {phoneCredits} call{phoneCredits !== 1 ? "s" : ""}
              </span>
            )}
            {videoCredits > 0 && (
              <span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
                <Video className="w-3 h-3 text-primary/50" />
                {videoCredits} video
              </span>
            )}
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-2">
          <span className="text-base font-bold tabular-nums">{price}</span>
          <Button
            size="sm"
            variant={isBestValue ? "default" : "outline"}
            disabled={loading}
            onClick={onBuy}
            className="h-7 text-xs px-3.5"
            data-testid={`button-buy-${itemId}`}
          >
            {loading ? "…" : "Get Pack"}
          </Button>
        </div>
      </div>
    </div>
  );
}
