import { useState, useEffect, useRef } from "react";
import { useLocation } from "wouter";
import { useTabActive } from "@/hooks/use-tab-active";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { LulouFlowerIcon } from "@/components/app-layout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { upsertProfile, cleanErrorMessage, withRetry } from "@/lib/profile-upsert";
import { apiRequest } from "@/lib/queryClient";
import { convertPhotoToJpeg, recompressPhotoDataUrl, uploadPhotoToStorage, OVERSIZED_THRESHOLD } from "@/lib/photo-utils";
import { supabase } from "@/lib/supabase";
import { useLanguageContext } from "@/contexts/language-context";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  MapPin,
  Ruler,
  Calendar,
  Camera,
  HelpCircle,
  ChevronDown,
  BadgeCheck,
  Settings,
  Pencil,
  X,
  ImagePlus,
  MessageSquare,
  Check,
  ChevronRight,
  Menu,
  Sparkles,
  Plus,
  ChevronUp,
} from "lucide-react";
import { DragScrollRow } from "@/components/drag-scroll-row";
import { ElevateModal } from "@/components/elevate-modal";
import { CONVERSATION_STARTERS, PROFILE_QUESTIONS } from "@shared/schema";
import type { Profile } from "@shared/schema";

const _DEV = import.meta.env.DEV;


export default function ProfilePage() {
  const [, navigate] = useLocation();
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { t } = useLanguageContext();
  const isTabActive = useTabActive();
  const [expandedSection, setExpandedSection] = useState<string | null>(null);
  const [showExtendedInfo, setShowExtendedInfo] = useState(false);
  const [showElevateModal, setShowElevateModal] = useState(false);

  // Reset the "More about me" drawer whenever this tab comes back into view
  // (PersistentTabs keeps this component mounted, so state persists across navigation)
  useEffect(() => {
    if (isTabActive) setShowExtendedInfo(false);
  }, [isTabActive]);

  const _mountMs = useRef(performance.now());
  useEffect(() => {
    if (_DEV) console.log("[PERF] PROFILE_FIRST_RENDER", { ms: Math.round(_mountMs.current) });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Guard: ensures the one-time base64→Storage migration runs at most once per session.
  const photoMigrationRan = useRef(false);

  useEffect(() => {
    // Only detect Stripe cancel when the URL actually has ?checkout=cancelled.
    // This effect runs once on mount — if ProfilePage is incorrectly unmounted/remounted
    // due to a routing bug, this will fire again. The [STRIPE_CANCEL] log below will
    // reveal if that is happening. Routing fixes in App.tsx should prevent remounting.
    if (window.location.pathname === "/profile") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("checkout") === "cancelled") {
        if (_DEV) console.log("[STRIPE_CANCEL] Detected ?checkout=cancelled on /profile — showing toast and clearing param");
        toast({ title: "Payment cancelled", description: "Your purchase was not completed." });
        const url = new URL(window.location.href);
        url.searchParams.delete("checkout");
        window.history.replaceState({}, "", url.toString());
      } else {
        if (_DEV) console.log("[STRIPE_CANCEL] ProfilePage mounted on /profile — no cancel param present, no toast shown");
      }
    }
  }, []);

  useEffect(() => {
    if (_DEV) console.log("[PROFILE_PAGE] mounted");
    return () => { if (_DEV) console.log("[PROFILE_PAGE] unmounted"); };
  }, []);

  const { data: profile, isLoading, isError, error, refetch } = useQuery<Profile>({
    queryKey: ["/api/profile"],
    placeholderData: (prev) => prev,
    queryFn: async () => {
      if (_DEV) console.log("[PROFILE_PAGE] fetch start — /api/profile");
      const { getAuthHeaders, logLatency, parseServerTiming, PERF_ENABLED, API_BASE, requireApiBase } = await import("@/lib/queryClient");
      requireApiBase("/api/profile");
      const authHeaders = await getAuthHeaders();
      const t0 = PERF_ENABLED ? performance.now() : 0;
      const res = await fetch(API_BASE + "/api/profile", { credentials: "include", headers: authHeaders });
      if (_DEV) console.log("[PROFILE_PAGE] fetch response:", res.status);
      if (res.status === 404) {
        console.warn("[PROFILE_PAGE] 404 — no profile row found");
        return null;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        console.error("[PROFILE_PAGE] fetch error:", res.status, text.slice(0, 200));
        throw new Error(`${res.status}: ${text.slice(0, 120)}`);
      }
      // Guard: Safari throws "The string did not match the expected pattern."
      // when JSON.parse() receives HTML (e.g. Vercel's SPA catch-all returning
      // index.html for /api/profile when VITE_API_BASE_URL is not set).
      // Check content-type BEFORE calling res.json() so we can give a clear error.
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        const preview = await res.text().catch(() => "").then(t => t.slice(0, 80));
        const isHtml = preview.trimStart().toLowerCase().startsWith("<");
        const msg = isHtml
          ? "API unreachable — set VITE_API_BASE_URL in Vercel environment variables to your Replit backend URL"
          : `Unexpected response (${ct || "no content-type"})`;
        console.error("[PROFILE_PAGE] non-JSON response:", { status: res.status, ct, preview });
        throw new Error(msg);
      }
      const data = await res.json();
      // TEMP: latency debugging — remove before production release
      if (PERF_ENABLED) {
        logLatency("/api/profile", Math.round(performance.now() - t0), parseServerTiming(res.headers.get("server-timing")), Math.round(JSON.stringify(data).length / 1024));
      }
      if (_DEV) console.log("[PROFILE_PAGE] data received, userId:", data?.userId, "firstName:", data?.firstName);
      return data;
    },
  });

  useEffect(() => {
    if (_DEV) console.log("[PROFILE_PAGE] query state — isLoading:", isLoading, "isError:", isError, "hasData:", !!profile);
  }, [isLoading, isError, profile]);

  // ── One-time base64→Storage photo migration ───────────────────────────────
  // Runs silently in the background the first time the logged-in user's profile
  // loads and any photos are still stored as base64 data URLs.
  //
  // Safety guarantees:
  //  • photoMigrationRan ref — fires at most once per session even if `profile`
  //    re-renders (e.g. after a save).
  //  • Per-photo try/catch — a single upload failure keeps that photo as base64;
  //    the rest still migrate.
  //  • changedCount guard — the DB write is skipped if zero photos changed,
  //    so already-migrated profiles produce zero network traffic.
  //  • setQueryData (not invalidate) — avoids the AppContent race condition that
  //    previously caused the profile-exists check to misfire.
  useEffect(() => {
    if (photoMigrationRan.current) return;
    if (!profile?.photos?.length || !user?.id) return;

    const hasBase64 = profile.photos.some(p => p.startsWith("data:"));
    if (!hasBase64) return;

    photoMigrationRan.current = true;
    if (_DEV) console.log("[PHOTO_MIGRATION] Starting — found base64 photos in profile");

    (async () => {
      const migrated = await Promise.all(
        profile.photos.map(async (photo, i) => {
          if (!photo.startsWith("data:")) return photo; // already a Storage URL
          try {
            const url = await uploadPhotoToStorage(photo, user.id, supabase);
            if (_DEV) console.log(`[PHOTO_MIGRATION] Photo ${i}: migrated to Storage`);
            return url;
          } catch (err: any) {
            console.warn(`[PHOTO_MIGRATION] Photo ${i}: upload failed, keeping base64 —`, err?.message);
            return photo;
          }
        })
      );

      const changedCount = migrated.filter((p, i) => p !== profile.photos[i]).length;
      if (changedCount === 0) {
        if (_DEV) console.log("[PHOTO_MIGRATION] No photos changed — skipping DB write");
        return;
      }

      if (_DEV) console.log(`[PHOTO_MIGRATION] ${changedCount}/${profile.photos.length} photo(s) migrated — saving to DB`);
      try {
        await apiRequest("POST", "/api/profile", { photos: migrated });
        queryClient.setQueryData(["/api/profile"], (prev: any) =>
          prev ? { ...prev, photos: migrated } : prev
        );
        if (_DEV) console.log("[PHOTO_MIGRATION] Complete — cache updated");
      } catch (err: any) {
        console.warn("[PHOTO_MIGRATION] DB save failed:", err?.message);
      }
    })();
  // profile.photos identity changes when the query resolves — dep is intentional.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, user]);

  const updateProfileField = useMutation({
    mutationFn: async (data: Record<string, unknown>) => {
      // MUST go through the Express route — NOT direct Supabase upsert.
      //
      // upsertProfile() bypasses the Express POST /api/profile handler, so the
      // server-side _userDiscoverMeta cache (10-min TTL) is never busted.
      // When the user saves a new age range, the next /api/discover call would
      // read the stale cached ageMin/ageMax and pass them to getDiscoverProfiles,
      // so out-of-range profiles kept appearing even though the DB was updated and
      // the client query cache was invalidated.
      //
      // Going through the Express route ensures _userDiscoverMeta.delete(userId)
      // runs on the server before the client re-fetches /api/discover.
      return apiRequest("POST", "/api/profile", data);
    },
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["/api/profile"] });
      // Bust client discover + wheel caches for any pref that affects the pool.
      if (
        "preferredAgeMin" in variables ||
        "preferredAgeMax" in variables ||
        "locationRadius" in variables ||
        "location" in variables
      ) {
        queryClient.invalidateQueries({ queryKey: ["/api/discover"] });
        queryClient.invalidateQueries({ queryKey: ["/api/popular"] });
      }
    },
    onError: (err: any) => {
      const msg = cleanErrorMessage(err);
      console.error("[PROFILE_SAVE] updateProfileField FAILED", { rawError: err?.message, cleanedError: msg });
      toast({ title: "Couldn't save change", description: msg, variant: "destructive" });
    },
  });


  const [editingPhotos, setEditingPhotos] = useState(false);
  const [editPhotos, setEditPhotos] = useState<string[]>([]);
  const [showPhotos, setShowPhotos] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const replaceIndexRef = useRef<number | null>(null);

  const openFilePicker = (replaceIndex?: number) => {
    replaceIndexRef.current = replaceIndex ?? null;
    if (_DEV) console.log("[PHOTOS] Opening file picker", replaceIndex != null ? `to replace slot ${replaceIndex}` : "to add new photo");
    if (fileInputRef.current) {
      fileInputRef.current.click();
    } else {
      console.error("[PHOTOS] fileInputRef is null — file picker could not open");
    }
  };

  const startEditingPhotos = async () => {
    if (_DEV) console.log("[PHOTOS] Entering edit mode");
    const existing = [...(profile?.photos || [])];
    const oversized = existing.some(p => p.length > OVERSIZED_THRESHOLD);

    if (oversized) {
      toast({
        title: "Optimising photos…",
        description: "Your photos are being compressed to improve loading speed.",
      });
      const recompressed = await Promise.all(
        existing.map(p => p.length > OVERSIZED_THRESHOLD ? recompressPhotoDataUrl(p) : Promise.resolve(p))
      );
      setEditPhotos(recompressed);
      toast({ title: "Photos ready", description: "Save to apply the optimised versions." });
    } else {
      setEditPhotos(existing);
    }
    setShowPhotos(true);
    setEditingPhotos(true);
    if (_DEV) console.log("[PHOTOS] Edit mode active, existing photos:", existing.length);
  };

  const cancelEditingPhotos = () => {
    setEditingPhotos(false);
    setEditPhotos([]);
    replaceIndexRef.current = null;
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const rawFiles = e.target.files;
    if (!rawFiles || rawFiles.length === 0) {
      if (_DEV) console.log("[PHOTOS] No files selected");
      return;
    }
    // Convert to Array BEFORE clearing the input — clearing can invalidate the FileList on some mobile browsers
    const fileArray = Array.from(rawFiles);
    if (fileInputRef.current) fileInputRef.current.value = "";

    const isReplacing = replaceIndexRef.current !== null;
    const replaceIdx = replaceIndexRef.current;
    replaceIndexRef.current = null;

    if (_DEV) console.log("[PHOTOS] Files selected:", fileArray.length, isReplacing ? `replacing slot ${replaceIdx}` : "adding new");

    if (isReplacing && replaceIdx !== null) {
      const file = fileArray[0];
      try {
        if (_DEV) console.log("[PHOTOS] Converting replacement photo:", file.name, `(${(file.size / 1024).toFixed(0)} KB)`);
        const jpeg = await convertPhotoToJpeg(file);
        if (_DEV) console.log("[PHOTOS] Replacement ready:", (jpeg.length / 1024).toFixed(0), "KB base64");
        setEditPhotos(prev => {
          const updated = [...prev];
          updated[replaceIdx] = jpeg;
          return updated;
        });
      } catch (err: any) {
        console.error("[PHOTOS] Replacement failed:", err?.message);
        toast({
          title: "Photo not replaced",
          description: err?.message || "Could not process this photo. Try a JPEG or PNG.",
          variant: "destructive",
        });
      }
    } else {
      const slots = 6 - editPhotos.length;
      const toProcess = fileArray.slice(0, slots);
      if (_DEV) console.log("[PHOTOS] Adding", toProcess.length, "new photo(s), slots available:", slots);
      for (const file of toProcess) {
        try {
          if (_DEV) console.log("[PHOTOS] Converting:", file.name, `(${(file.size / 1024).toFixed(0)} KB)`);
          const jpeg = await convertPhotoToJpeg(file);
          if (_DEV) console.log("[PHOTOS] Converted:", (jpeg.length / 1024).toFixed(0), "KB base64");
          setEditPhotos(prev => prev.length < 6 ? [...prev, jpeg] : prev);
        } catch (err: any) {
          console.error("[PHOTOS] Conversion failed:", file.name, err?.message);
          toast({
            title: "Photo not added",
            description: err?.message || "Could not process this photo. Try a JPEG or PNG.",
            variant: "destructive",
          });
        }
      }
    }
  };

  const removeEditPhoto = (index: number) => {
    if (_DEV) console.log("[PHOTOS] Removing photo at index", index);
    setEditPhotos(prev => prev.filter((_, i) => i !== index));
  };

  const savePhotos = useMutation({
    mutationFn: async () => {
      if (_DEV) console.log("[PROFILE_SAVE] START", { label: "savePhotos", photoCount: editPhotos.length });

      // Upload any base64 photos to Supabase Storage and replace them with
      // public URLs.  Photos already stored as HTTPS URLs (from a previous save)
      // pass through unchanged.  If an individual upload fails, we silently keep
      // the base64 for that slot so the save never blocks on a network error.
      const photosToSave = await Promise.all(
        editPhotos.map(async (photo, i) => {
          if (!photo.startsWith("data:")) return photo; // already a Storage URL
          try {
            const url = await uploadPhotoToStorage(photo, user!.id, supabase);
            if (_DEV) console.log(`[PROFILE_SAVE] Photo ${i}: uploaded to Storage`);
            return url;
          } catch (err: any) {
            console.warn(`[PROFILE_SAVE] Photo ${i}: Storage upload failed, keeping base64 —`, err?.message);
            return photo;
          }
        })
      );

      const base64Count = photosToSave.filter(p => p.startsWith("data:")).length;
      const urlCount    = photosToSave.length - base64Count;
      if (_DEV) console.log(`[PROFILE_SAVE] Photos ready: ${urlCount} Storage URL(s), ${base64Count} base64 fallback(s)`);

      // withRetry retries up to 2 times on transient network/5xx errors.
      const res = await withRetry(
        () => apiRequest("POST", "/api/profile", { photos: photosToSave }),
        "savePhotos",
      );
      const data = await res.json();
      if (_DEV) console.log("[PROFILE_SAVE] SUCCESS", { label: "savePhotos", photosInDb: data?.photos?.length ?? "unknown" });
      return data;
    },
    onSuccess: (data) => {
      // Update the profile data cache directly — do NOT invalidate.
      // Invalidating ["/api/profile"] previously caused a race condition where
      // AppContent's existence-check query and ProfilePage's data query both tried to
      // refetch the same key. If the data fetcher won the race it would store a real
      // Profile object under the key that AppContent reads as ProfileCheckResult, making
      // profileExists evaluate to false and sending the user to onboarding.
      // setQueryData avoids any refetch and keeps the user on the Profile page.
      if (_DEV) console.log("[PHOTOS] Save successful — updating profile cache directly, staying on Profile page");
      queryClient.setQueryData(["/api/profile"], data);
      toast({ title: "Photos updated" });
      setEditingPhotos(false);
      setEditPhotos([]);
    },
    onError: (err: any) => {
      const msg = cleanErrorMessage(err);
      console.error("[PROFILE_SAVE] savePhotos FAILED", { rawError: err?.message, cleanedError: msg });
      // editPhotos is intentionally NOT cleared here — the user's selected
      // photos are preserved so they can retry without re-selecting them.
      toast({ title: "Could not save photos", description: msg, variant: "destructive" });
    },
  });

  const [settingsForm, setSettingsForm] = useState<Record<string, string | undefined>>({});
  const [editingStarters, setEditingStarters] = useState(false);
  const [editStarters, setEditStarters] = useState<string[]>([]);
  const [editStarterAnswers, setEditStarterAnswers] = useState<Record<string, string>>({});
  const [editingQuestions, setEditingQuestions] = useState(false);
  const [editQuestions, setEditQuestions] = useState<string[]>([]);
  const [editCustomQList, setEditCustomQList] = useState<Array<{ question: string; answer: string }>>([]);
  const [newCustomQDraft, setNewCustomQDraft] = useState({ question: "", answer: "" });
  const [editingCustomQ, setEditingCustomQ] = useState<number | null>(null);

  const initSettings = () => {
    if (profile) {
      setSettingsForm({
        location: profile.location,
        height: profile.height || "",
        datingPreference: profile.datingPreference,
        datingIntent: profile.datingIntent,
        connectionStyle: profile.connectionStyle,
      });
    }
  };

  const saveSettings = useMutation({
    mutationFn: async () => {
      return upsertProfile(settingsForm);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profile"] });
      toast({ title: "Settings saved" });
      setExpandedSection(null);
    },
    onError: (err: any) => {
      const msg = cleanErrorMessage(err);
      console.error("[PROFILE_SAVE] saveSettings FAILED", { rawError: err?.message, cleanedError: msg });
      // settingsForm is intentionally NOT cleared — user's edits are preserved for retry.
      toast({ title: "Settings couldn't be saved", description: msg, variant: "destructive" });
    },
  });

  const startEditingStarters = () => {
    if (profile) {
      const prompts: string[] = [];
      const answers: Record<string, string> = {};
      (profile.conversationStarters || []).forEach((s: string) => {
        const matchedPrompt = CONVERSATION_STARTERS.find(p => s.startsWith(p.replace(/\.\.\.$/, "")));
        if (matchedPrompt) {
          prompts.push(matchedPrompt);
          const answerPart = s.slice(matchedPrompt.length).trim();
          if (answerPart) answers[matchedPrompt] = answerPart;
        } else {
          prompts.push(s);
        }
      });
      setEditStarters(prompts);
      setEditStarterAnswers(answers);
      setEditingStarters(true);
    }
  };

  const startEditingQuestions = () => {
    if (profile) {
      setEditQuestions([...(profile.questions || [])]);
      setEditCustomQList([...((profile as any).customQuestions || [])]);
      setNewCustomQDraft({ question: "", answer: "" });
      setEditingCustomQ(null);
      setEditingQuestions(true);
    }
  };

  const toggleStarter = (starter: string) => {
    setEditStarters(prev => {
      if (prev.includes(starter)) return prev.filter(s => s !== starter);
      if (prev.length >= 3) return prev;
      return [...prev, starter];
    });
  };

  const toggleQuestion = (question: string) => {
    setEditQuestions(prev => {
      if (prev.includes(question)) return prev.filter(q => q !== question);
      if (prev.length >= 3) return prev;
      return [...prev, question];
    });
  };

  const saveStarters = useMutation({
    mutationFn: async () => {
      const fullStarters = editStarters.map(s => {
        const answer = editStarterAnswers[s];
        return answer ? `${s} ${answer}` : s;
      });
      return upsertProfile({ conversationStarters: fullStarters });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profile"] });
      toast({ title: "Conversation starters updated" });
      setEditingStarters(false);
    },
    onError: (err: any) => {
      const msg = cleanErrorMessage(err);
      console.error("[PROFILE_SAVE] saveStarters FAILED", { rawError: err?.message, cleanedError: msg });
      // editStarters / editStarterAnswers are intentionally NOT cleared — user's selections are preserved.
      toast({ title: "Couldn't save starters", description: msg, variant: "destructive" });
    },
  });

  const saveQuestionsMut = useMutation({
    mutationFn: async () => {
      return apiRequest("POST", "/api/profile", { questions: editQuestions, customQuestions: editCustomQList });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profile"] });
      toast({ title: "Questions updated" });
      setEditingQuestions(false);
    },
    onError: (err: any) => {
      const msg = cleanErrorMessage(err);
      console.error("[PROFILE_SAVE] saveQuestionsMut FAILED", { rawError: err?.message, cleanedError: msg });
      toast({ title: "Couldn't save questions", description: msg, variant: "destructive" });
    },
  });

  const moveCustomQ = (from: number, to: number) => {
    setEditCustomQList(prev => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const toggle = (section: string) => {
    if (section === "settings" && expandedSection !== "settings") {
      initSettings();
    }
    setExpandedSection(prev => prev === section ? null : section);
  };

  // ─── STEP 7: Render-phase log ───────────────────────────────────────────────
  if (_DEV) console.log("[PROFILE] RENDER_REACHED", {
    userId: user?.id,
    isLoading,
    isError,
    hasProfile: !!profile,
    profileFirstName: profile?.firstName,
  });

  // ─── STEP 2: Minimal render — confirms routing/layout works ─────────────────
  const STEP2_MINIMAL = false;
  if (STEP2_MINIMAL) {
    return (
      <div className="flex-1 p-6 space-y-3" data-testid="profile-diagnostic">
        <h2 className="text-lg font-semibold">Profile — Page Rendered ✓</h2>
        <div className="text-xs font-mono text-muted-foreground space-y-0.5">
          <div>userId: {user?.id?.slice(0, 8) ?? "—"}</div>
          <div>isLoading: {String(isLoading)}</div>
          <div>isError: {String(isError)}</div>
          <div>hasProfile: {String(!!profile)}</div>
          <div>firstName: {profile?.firstName ?? "—"}</div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex-1 p-6 space-y-6 max-w-lg mx-auto w-full">
        <div className="flex items-center gap-4">
          <Skeleton className="w-20 h-20 rounded-full" />
          <div className="space-y-2">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-24" />
          </div>
        </div>
        <Skeleton className="h-40 w-full rounded-md" />
      </div>
    );
  }

  if (isError) {
    const errMsg = (error as Error)?.message ?? "Could not load profile";
    console.error("[PROFILE_PAGE] render error state:", errMsg);
    return (
      <div className="flex-1 flex items-center justify-center p-6" data-testid="profile-error-state">
        <div className="text-center space-y-4 max-w-xs">
          <LulouFlowerIcon className="w-12 h-12 text-primary mx-auto" />
          <p className="font-medium">Couldn't load your profile</p>
          <p className="text-sm text-muted-foreground">{errMsg}</p>
          <Button onClick={() => refetch()} variant="outline" data-testid="button-profile-retry">
            Try again
          </Button>
        </div>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-4">
          <LulouFlowerIcon className="w-12 h-12 text-primary mx-auto" />
          <p className="text-muted-foreground">Profile not found. Complete your onboarding to get started.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="sticky top-0 z-30 bg-background/95 backdrop-blur-sm border-b px-6 py-3 max-w-lg mx-auto w-full">
        <h1 className="font-serif text-lg font-bold truncate" data-testid="text-profile-sticky-name">
          {profile.firstName}
        </h1>
      </div>
      <div className="p-6 space-y-5 max-w-lg mx-auto w-full pb-28">

      {/* ① Name + avatar — very top */}
      <div className="flex items-center gap-4">
        <button
          className="relative shrink-0 group"
          onClick={startEditingPhotos}
          data-testid="button-avatar-edit"
          aria-label="Edit profile photos"
        >
          <Avatar className="w-20 h-20">
            <AvatarImage src={profile.photos?.[0]} alt={profile.firstName} />
            <AvatarFallback className="bg-primary/10 text-primary text-2xl font-semibold">
              {profile.firstName?.[0]}
            </AvatarFallback>
          </Avatar>
          <div className="absolute inset-0 rounded-full bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 group-active:opacity-100 transition-opacity">
            <Camera className="w-6 h-6 text-white" />
          </div>
          {profile.photoVerified && (
            <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-primary rounded-full flex items-center justify-center" data-testid="icon-verified-badge">
              <BadgeCheck className="w-4 h-4 text-primary-foreground" />
            </div>
          )}
        </button>
        <div className="flex-1">
          <div className="flex items-center justify-between gap-2">
            <h1 className="font-serif text-2xl font-bold" data-testid="text-profile-name">
              {profile.firstName}
            </h1>
            <Button size="icon" variant="ghost" onClick={() => navigate("/settings")} data-testid="button-settings-icon">
              <Settings className="w-5 h-5" />
            </Button>
          </div>
          {/* ② Age / location / details — immediately under name */}
          <div className="flex items-center gap-3 text-muted-foreground text-sm mt-1 flex-wrap">
            <span className="flex items-center gap-1" data-testid="text-profile-age">
              <Calendar className="w-3.5 h-3.5" />
              {profile.age}
            </span>
            {profile.height && (
              <span className="flex items-center gap-1" data-testid="text-profile-height">
                <Ruler className="w-3.5 h-3.5" />
                {profile.height}
              </span>
            )}
            {profile.location && (
              <span className="flex items-center gap-1" data-testid="text-profile-location">
                <MapPin className="w-3.5 h-3.5" />
                {profile.location}
              </span>
            )}
          </div>
          <Button
            size="sm"
            variant="outline"
            className="mt-3 text-xs h-8 px-3 gap-1.5"
            onClick={() => toggle("settings")}
            data-testid="button-edit-profile"
          >
            <Pencil className="w-3 h-3" />
            {t("edit_profile")}
            <ChevronRight className={`w-3 h-3 transition-transform ${expandedSection === "settings" ? "rotate-90" : ""}`} />
          </Button>
        </div>
      </div>

      {expandedSection === "settings" && (
        <Card className="p-5 space-y-4" data-testid="section-settings">
          <p className="font-medium text-sm">{t("edit_profile")}</p>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="settings-location" className="text-xs">{t("label_location")}</Label>
              <Input
                id="settings-location"
                value={settingsForm.location || ""}
                onChange={e => setSettingsForm(prev => ({ ...prev, location: e.target.value }))}
                placeholder="City, State"
                data-testid="input-settings-location"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="settings-height" className="text-xs">{t("label_height")}</Label>
              <Input
                id="settings-height"
                value={settingsForm.height || ""}
                onChange={e => setSettingsForm(prev => ({ ...prev, height: e.target.value }))}
                placeholder="e.g. 5'8&quot;"
                data-testid="input-settings-height"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("label_dating_pref")}</Label>
              <Select
                value={settingsForm.datingPreference || ""}
                onValueChange={v => setSettingsForm(prev => ({ ...prev, datingPreference: v }))}
              >
                <SelectTrigger data-testid="select-settings-preference">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="women">Women</SelectItem>
                  <SelectItem value="men">Men</SelectItem>
                  <SelectItem value="non-binary people">Non-binary People</SelectItem>
                  <SelectItem value="trans women">Trans Women</SelectItem>
                  <SelectItem value="trans men">Trans Men</SelectItem>
                  <SelectItem value="everyone">Everyone</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("label_intent")}</Label>
              <Select
                value={settingsForm.datingIntent || ""}
                onValueChange={v => setSettingsForm(prev => ({ ...prev, datingIntent: v }))}
              >
                <SelectTrigger data-testid="select-settings-intent">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Meaningful Relationship">Meaningful Relationship</SelectItem>
                  <SelectItem value="Intentional Dating">Intentional Dating</SelectItem>
                  <SelectItem value="Open but Serious">Open but Serious</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t("section_connection_style")}</Label>
              <Select
                value={settingsForm.connectionStyle || ""}
                onValueChange={v => setSettingsForm(prev => ({ ...prev, connectionStyle: v }))}
              >
                <SelectTrigger data-testid="select-settings-style">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="Slow & Intentional">Slow & Intentional</SelectItem>
                  <SelectItem value="Steady with Momentum">Steady with Momentum</SelectItem>
                  <SelectItem value="Ready to Meet Soon">Ready to Meet Soon</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button
            onClick={() => saveSettings.mutate()}
            disabled={saveSettings.isPending}
            className="w-full"
            data-testid="button-save-settings"
          >
            {saveSettings.isPending ? t("saving_msg") : t("save_changes")}
          </Button>
        </Card>
      )}

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowPhotos(!showPhotos)}
            className="flex items-center gap-1.5"
            data-testid="button-toggle-photos"
          >
            <Camera className="w-4 h-4 text-primary" />
            <span className="text-xs font-medium tracking-wider uppercase text-muted-foreground">{t("section_photos")}</span>
            {profile.photos && profile.photos.length > 0 && (
              <span className="text-xs text-muted-foreground">({profile.photos.length})</span>
            )}
            <ChevronDown className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${showPhotos ? 'rotate-180' : ''}`} />
          </Button>
          {showPhotos && !editingPhotos && (
            <Button size="sm" variant="ghost" onClick={startEditingPhotos} data-testid="button-edit-photos">
              <Pencil className="w-3.5 h-3.5 mr-1.5" /> {t("edit_photos_btn")}
            </Button>
          )}
          {showPhotos && editingPhotos && (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={cancelEditingPhotos} data-testid="button-cancel-photos">
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={() => savePhotos.mutate()}
                disabled={savePhotos.isPending || editPhotos.length === 0}
                data-testid="button-save-photos"
              >
                {savePhotos.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          )}
        </div>

        {showPhotos && (editingPhotos ? (
          <div className="grid grid-cols-3 gap-3">
            {editPhotos.map((photo, i) => (
              <div key={i} className="aspect-[3/4] overflow-hidden relative" style={{ borderRadius: 18 }}>
                <img
                  src={photo}
                  alt={`Photo ${i + 1}`}
                  className="w-full h-full object-cover cursor-pointer"
                  onClick={() => openFilePicker(i)}
                  data-testid={`img-edit-photo-${i}`}
                />
                <div className="absolute bottom-0 inset-x-0 flex items-center justify-center pb-1.5 pointer-events-none">
                  <span className="text-white text-[10px] font-medium bg-black/50 px-2 py-0.5 rounded-full leading-none">
                    {t("tap_to_replace_lbl")}
                  </span>
                </div>
                <button
                  onClick={() => removeEditPhoto(i)}
                  className="absolute top-1.5 right-1.5 w-7 h-7 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center shadow-md active:scale-95 transition-transform"
                  data-testid={`button-remove-photo-${i}`}
                  aria-label={`Remove photo ${i + 1}`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            {editPhotos.length < 6 && (
              <button
                onClick={() => openFilePicker()}
                className="aspect-[3/4] border-2 border-dashed border-muted-foreground/30 flex flex-col items-center justify-center gap-1 hover-elevate transition-colors"
                style={{ borderRadius: 18 }}
                data-testid="button-add-photo"
              >
                <ImagePlus className="w-6 h-6 text-muted-foreground/50" />
                <span className="text-xs text-muted-foreground/50">{t("add_photo_btn")}</span>
              </button>
            )}
          </div>
        ) : profile.photos && profile.photos.length > 0 ? (
          <div className="flex gap-3 overflow-x-auto scrollbar-hide py-2 px-1" style={{ WebkitOverflowScrolling: "touch" }}>
            {profile.photos.map((photo, i) => (
              <div
                key={i}
                style={{
                  flex: "0 0 auto",
                  width: i === 0 ? 140 : 100,
                  height: i === 0 ? 190 : 140,
                  borderRadius: 20,
                  overflow: "hidden",
                  boxShadow: i === 0
                    ? "0 8px 20px -4px rgba(0,0,0,0.15)"
                    : "0 4px 12px -2px rgba(0,0,0,0.08)",
                }}
                data-testid={`photo-bubble-profile-${i}`}
              >
                <img src={photo} alt={`Photo ${i + 1}`} className="w-full h-full object-cover" data-testid={`img-my-photo-${i}`} />
              </div>
            ))}
          </div>
        ) : (
          <button
            onClick={startEditingPhotos}
            className="w-full aspect-[3/4] max-w-[140px] border-2 border-dashed border-muted-foreground/30 flex flex-col items-center justify-center gap-1 hover-elevate"
            style={{ borderRadius: 20 }}
            data-testid="button-add-first-photo"
          >
            <ImagePlus className="w-8 h-8 text-muted-foreground/50" />
            <span className="text-xs text-muted-foreground/50">{t("add_photos_btn")}</span>
          </button>
        ))}
      </div>

      {/* ── 3-line toggle for extended info ── */}
      <button
        className="w-full flex items-center justify-between gap-3 py-3 px-4 rounded-xl border bg-card hover:bg-muted/50 transition-colors"
        onClick={() => setShowExtendedInfo(v => !v)}
        data-testid="button-toggle-extended-info"
        aria-expanded={showExtendedInfo}
      >
        <div className="flex items-center gap-2.5">
          <Menu className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm font-medium text-muted-foreground">More about me</span>
        </div>
        <ChevronDown
          className={`w-4 h-4 text-muted-foreground transition-transform duration-200 ${showExtendedInfo ? "rotate-180" : ""}`}
        />
      </button>

      {showExtendedInfo && (<>
      <Card className="p-5 space-y-4">
        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wider uppercase text-primary">{t("section_personality")}</p>
          <DragScrollRow>
            {profile.signals?.map(signal => (
              <Badge key={signal} variant="secondary" className="text-sm py-1.5 px-3 shrink-0 no-default-active-elevate" data-testid={`badge-my-signal-${signal}`}>
                {signal}
              </Badge>
            ))}
          </DragScrollRow>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wider uppercase text-primary">{t("section_looking_for")}</p>
          <p className="font-medium" data-testid="text-my-intent">{profile.datingIntent}</p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wider uppercase text-primary">{t("section_green_flags")}</p>
          <DragScrollRow>
            {profile.greenFlags?.map(flag => (
              <Badge key={flag} variant="outline" className="text-sm py-1.5 px-3 shrink-0 no-default-active-elevate" data-testid={`badge-my-flag-${flag}`}>
                {flag}
              </Badge>
            ))}
          </DragScrollRow>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wider uppercase text-primary">{t("section_connection_style")}</p>
          <p className="font-medium" data-testid="text-my-style">{profile.connectionStyle}</p>
        </div>
      </Card>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <MessageSquare className="w-4 h-4 text-primary" />
            <p className="text-xs font-medium tracking-wider uppercase text-muted-foreground">{t("conversation_starters")}</p>
          </div>
          {!editingStarters ? (
            <Button size="sm" variant="ghost" onClick={startEditingStarters} data-testid="button-edit-starters">
              <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditingStarters(false)} data-testid="button-cancel-starters">Cancel</Button>
              <Button size="sm" onClick={() => saveStarters.mutate()} disabled={saveStarters.isPending || editStarters.length < 2} data-testid="button-save-starters">
                {saveStarters.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          )}
        </div>
        {editingStarters ? (
          <Card className="p-4 space-y-4" data-testid="section-edit-starters">
            <div className="flex flex-wrap gap-2">
              {CONVERSATION_STARTERS.map(starter => {
                const selected = editStarters.includes(starter);
                return (
                  <Badge
                    key={starter}
                    variant={selected ? "default" : "outline"}
                    className={`cursor-pointer text-sm py-2 px-3 transition-all ${selected ? "bg-primary text-primary-foreground" : ""}`}
                    onClick={() => toggleStarter(starter)}
                    data-testid={`badge-edit-starter-${starter.slice(0, 20).toLowerCase().replace(/\s+/g, "-")}`}
                  >
                    {selected && <Check className="w-3 h-3 mr-1" />}
                    {starter}
                  </Badge>
                );
              })}
            </div>
            <p className="text-xs text-muted-foreground">{editStarters.length}/3 {t("selected_min2")}</p>
            {editStarters.map(starter => (
              <div key={starter} className="space-y-1.5">
                <p className="text-sm font-medium text-primary">{starter}</p>
                <Input
                  value={editStarterAnswers[starter] || ""}
                  onChange={e => setEditStarterAnswers(prev => ({ ...prev, [starter]: e.target.value }))}
                  placeholder="Your answer..."
                  maxLength={200}
                  data-testid={`input-edit-starter-${starter.slice(0, 20).toLowerCase().replace(/\s+/g, "-")}`}
                />
              </div>
            ))}
          </Card>
        ) : profile.conversationStarters && profile.conversationStarters.length > 0 ? (
          <div className="space-y-2">
            {profile.conversationStarters.map((starter: string, i: number) => (
              <Card key={i} className="p-3" data-testid={`card-my-starter-${i}`}>
                <p className="text-sm">{starter}</p>
              </Card>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{t("no_starters_msg")}</p>
        )}
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <HelpCircle className="w-4 h-4 text-primary" />
            <p className="text-xs font-medium tracking-wider uppercase text-muted-foreground">{t("profile_questions")}</p>
          </div>
          {!editingQuestions ? (
            <Button size="sm" variant="ghost" onClick={startEditingQuestions} data-testid="button-edit-questions">
              <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditingQuestions(false)} data-testid="button-cancel-questions">Cancel</Button>
              <Button size="sm" onClick={() => saveQuestionsMut.mutate()} disabled={saveQuestionsMut.isPending || editQuestions.length < 2} data-testid="button-save-questions">
                {saveQuestionsMut.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          )}
        </div>
        {editingQuestions ? (
          <Card className="p-4 space-y-3" data-testid="section-edit-questions">
            {PROFILE_QUESTIONS.map(question => {
              const selected = editQuestions.includes(question);
              return (
                <Card
                  key={question}
                  className={`p-3 cursor-pointer transition-all hover-elevate ${selected ? "border-primary bg-primary/5" : ""}`}
                  onClick={() => toggleQuestion(question)}
                  data-testid={`card-edit-question-${question.slice(0, 25).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm">{question}</span>
                    {selected && (
                      <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center shrink-0">
                        <Check className="w-3 h-3 text-primary-foreground" />
                      </div>
                    )}
                  </div>
                </Card>
              );
            })}
            <p className="text-xs text-muted-foreground">{editQuestions.length}/3 selected (min 2)</p>

            {/* ── Custom Questions ───────────────────────────────── */}
            <div className="pt-2 border-t space-y-2">
              <p className="text-xs font-medium tracking-wider uppercase text-primary">Your own questions</p>
              {editCustomQList.map((cq, i) => (
                <Card key={i} className="p-3 border-primary/30 bg-primary/3 space-y-1" data-testid={`card-edit-custom-question-${i}`}>
                  {editingCustomQ === i ? (
                    <div className="space-y-2">
                      <Input
                        value={cq.question}
                        onChange={e => setEditCustomQList(prev => prev.map((q, j) => j === i ? { ...q, question: e.target.value } : q))}
                        placeholder="Question"
                        maxLength={150}
                        className="text-sm"
                        data-testid={`input-edit-custom-q-text-${i}`}
                      />
                      <Input
                        value={cq.answer}
                        onChange={e => setEditCustomQList(prev => prev.map((q, j) => j === i ? { ...q, answer: e.target.value } : q))}
                        placeholder="Answer"
                        maxLength={200}
                        className="text-sm"
                        data-testid={`input-edit-custom-q-answer-${i}`}
                      />
                      <Button size="sm" variant="outline" onClick={() => setEditingCustomQ(null)} data-testid={`button-done-custom-q-${i}`}>Done</Button>
                    </div>
                  ) : (
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-primary truncate">{cq.question}</p>
                        {cq.answer && <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{cq.answer}</p>}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <button onClick={() => moveCustomQ(i, i - 1)} disabled={i === 0} className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground disabled:opacity-30 hover:bg-muted transition-colors" data-testid={`button-move-custom-q-up-${i}`}><ChevronUp className="w-3.5 h-3.5" /></button>
                        <button onClick={() => moveCustomQ(i, i + 1)} disabled={i === editCustomQList.length - 1} className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground disabled:opacity-30 hover:bg-muted transition-colors" data-testid={`button-move-custom-q-down-${i}`}><ChevronDown className="w-3.5 h-3.5" /></button>
                        <button onClick={() => setEditingCustomQ(i)} className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:bg-muted transition-colors" data-testid={`button-edit-custom-q-${i}`}><Pencil className="w-3 h-3" /></button>
                        <button onClick={() => { setEditCustomQList(prev => prev.filter((_, j) => j !== i)); if (editingCustomQ === i) setEditingCustomQ(null); }} className="w-6 h-6 rounded flex items-center justify-center text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors" data-testid={`button-delete-custom-q-${i}`}><X className="w-3 h-3" /></button>
                      </div>
                    </div>
                  )}
                </Card>
              ))}

              {editCustomQList.length < 3 && editingCustomQ === null && (
                <Card className="p-3 space-y-2 border-dashed" data-testid="card-add-custom-q">
                  <p className="text-xs text-muted-foreground">Write your own question</p>
                  <Input
                    value={newCustomQDraft.question}
                    onChange={e => setNewCustomQDraft(prev => ({ ...prev, question: e.target.value }))}
                    placeholder="e.g. What's your idea of a perfect date?"
                    maxLength={150}
                    className="text-sm"
                    data-testid="input-new-custom-q-text"
                  />
                  <Input
                    value={newCustomQDraft.answer}
                    onChange={e => setNewCustomQDraft(prev => ({ ...prev, answer: e.target.value }))}
                    placeholder="Your answer..."
                    maxLength={200}
                    className="text-sm"
                    data-testid="input-new-custom-q-answer"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!newCustomQDraft.question.trim() || !newCustomQDraft.answer.trim()}
                    onClick={() => {
                      if (!newCustomQDraft.question.trim() || !newCustomQDraft.answer.trim()) return;
                      setEditCustomQList(prev => [...prev, { question: newCustomQDraft.question.trim(), answer: newCustomQDraft.answer.trim() }]);
                      setNewCustomQDraft({ question: "", answer: "" });
                    }}
                    className="gap-1.5"
                    data-testid="button-add-custom-q"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add question
                  </Button>
                </Card>
              )}
            </div>
          </Card>
        ) : (profile.questions && profile.questions.length > 0) || ((profile as any).customQuestions && (profile as any).customQuestions.length > 0) ? (
          <div className="space-y-2">
            {(profile.questions || []).map((question: string, i: number) => (
              <Card key={`lulou-${i}`} className="p-3" data-testid={`card-my-question-${i}`}>
                <p className="text-sm">{question}</p>
              </Card>
            ))}
            {((profile as any).customQuestions || []).map((cq: { question: string; answer: string }, i: number) => (
              <Card key={`custom-${i}`} className="p-3 border-primary/20 bg-primary/3" data-testid={`card-my-custom-question-${i}`}>
                <p className="text-sm font-medium text-primary">{cq.question}</p>
                {cq.answer && <p className="text-xs text-muted-foreground mt-1">{cq.answer}</p>}
              </Card>
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No questions yet. Tap Edit to add some.</p>
        )}
      </div>
      </>)}

      {/* ⑤ Main/profile picture — below More About Me */}
      <div
        className="relative rounded-3xl overflow-hidden w-full flex flex-col justify-end"
        style={{
          height: "clamp(300px, 80vw, 500px)",
          background: "linear-gradient(150deg, hsl(350 55% 78%) 0%, hsl(340 65% 68%) 45%, hsl(310 50% 62%) 100%)",
        }}
        data-testid="section-hero"
      >
        <div className="absolute -top-16 -right-16 w-64 h-64 rounded-full bg-white/10 pointer-events-none" />
        <div className="absolute top-8 left-4 w-28 h-28 rounded-full bg-white/8 pointer-events-none" />
        <div className="absolute -bottom-10 -left-10 w-40 h-40 rounded-full bg-black/10 pointer-events-none" />
        <img
          src="https://images.unsplash.com/photo-1516589178581-6cd7833ae3b2?w=900&auto=format&fit=crop&q=80"
          alt=""
          aria-hidden="true"
          className="absolute inset-0 w-full h-full object-cover object-center"
          onError={e => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
          data-testid="img-hero-couple"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/15 to-transparent pointer-events-none" />
        <div className="relative z-10 p-6">
          <p className="text-white/80 text-xs font-semibold tracking-widest uppercase mb-1.5">Lulou Dating</p>
          <p className="text-white font-serif text-2xl font-bold leading-tight drop-shadow-md">
            Where real connections<br />flourish
          </p>
          <p className="text-white/70 text-sm mt-2">Your story starts here</p>
        </div>
      </div>

      {/* ⑥ Elevate/upgrade content — below picture */}
      <div
        className="rounded-2xl border border-primary/25 p-4 flex items-center gap-3"
        style={{ background: "linear-gradient(135deg, hsl(350 45% 98%), hsl(350 45% 95%))" }}
        data-testid="card-elevate-promo"
      >
        <div className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
          <Sparkles className="w-5 h-5 text-primary" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold leading-snug">Get 3x as many dates with Elevate.</p>
          <p className="text-xs text-muted-foreground mt-0.5">Boost your visibility in discovery</p>
        </div>
        <Button
          size="sm"
          className="shrink-0"
          onClick={() => setShowElevateModal(true)}
          data-testid="button-elevate-upgrade"
        >
          Upgrade
        </Button>
      </div>

      {user?.email === "abayomibalogun@icloud.com" && import.meta.env.DEV && (
        <Button
          variant="destructive"
          className="w-full opacity-60"
          onClick={async () => {
            try {
              await apiRequest("POST", "/api/dev/reset-test-data");
              queryClient.invalidateQueries();
              toast({ title: "Test data cleared", description: "Interactions, matches, and spins reset." });
            } catch (err: any) {
              toast({ title: "Reset failed", description: err?.message || "Something went wrong", variant: "destructive" });
            }
          }}
          data-testid="button-reset-test-data"
        >
          Reset Test Data
        </Button>
      )}
      </div>

      {/* File input always mounted so fileInputRef is valid when openFilePicker() is called */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFileSelect}
        data-testid="input-photo-file"
      />

      {/* Elevate purchase modal — opened from the Upgrade promo card */}
      {showElevateModal && (
        <ElevateModal
          onClose={() => setShowElevateModal(false)}
          cancelPath="/profile"
        />
      )}
    </div>
  );
}
