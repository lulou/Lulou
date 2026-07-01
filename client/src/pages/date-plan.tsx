import { useState, useEffect, useMemo, useRef } from "react";
import { useParams, useLocation } from "wouter";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Heart, ArrowLeft, CheckCircle2, MapPin, Clock,
  Calendar, Sparkles, Shield, ExternalLink, Star,
  ChevronDown, ChevronUp, RefreshCw,
} from "lucide-react";

// ── Inject keyframes at module scope (Safari-safe — no useEffect) ──────
const STYLE_ID = "date-plan-keyframes";
if (typeof document !== "undefined" && !document.getElementById(STYLE_ID)) {
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    @keyframes dp-fade-up { from { opacity:0; transform:translateY(18px); } to { opacity:1; transform:translateY(0); } }
    @keyframes dp-pop { 0%{transform:scale(0.7);opacity:0;} 70%{transform:scale(1.08);opacity:1;} 100%{transform:scale(1);} }
    @keyframes dp-confetti-fall { 0%{transform:translateY(-10px) rotate(0deg);opacity:1;} 100%{transform:translateY(120px) rotate(360deg);opacity:0;} }
    @keyframes dp-pulse-heart { 0%,100%{transform:scale(1);} 50%{transform:scale(1.18);} }
    .dp-fade-up { animation: dp-fade-up 0.45s ease both; }
    .dp-pop { animation: dp-pop 0.4s cubic-bezier(0.34,1.56,0.64,1) both; }
    .dp-pulse-heart { animation: dp-pulse-heart 1.6s ease-in-out infinite; }
  `;
  document.head.appendChild(s);
}

// ── Data ───────────────────────────────────────────────────────────────
const DATE_TYPES = [
  { id: "coffee",           emoji: "☕", label: "Coffee" },
  { id: "drinks",           emoji: "🍸", label: "Drinks" },
  { id: "dinner",           emoji: "🍽",  label: "Dinner" },
  { id: "sunset_walk",      emoji: "🌅", label: "Sunset walk" },
  { id: "activities",       emoji: "🎳", label: "Activities" },
  { id: "beach",            emoji: "🏖",  label: "Beach" },
  { id: "brunch",           emoji: "🥐", label: "Brunch" },
  { id: "ice_cream",        emoji: "🍦", label: "Ice cream" },
  { id: "wine_bar",         emoji: "🍷", label: "Wine bar" },
  { id: "something_unique", emoji: "🎨", label: "Something unique" },
];

const TIME_SLOTS = [
  "10:00","10:30","11:00","11:30","12:00","12:30",
  "13:00","14:00","15:00","16:00","17:00","17:30",
  "18:00","18:30","19:00","19:30","20:00","20:30",
  "21:00","21:30",
];

const FEEDBACK_OPTIONS = [
  { id: "amazing",     emoji: "❤️",  label: "Amazing" },
  { id: "good",        emoji: "😊", label: "Good" },
  { id: "okay",        emoji: "😐", label: "Okay" },
  { id: "not_great",   emoji: "😕", label: "Not great" },
  { id: "didnt_happen",emoji: "👎", label: "Didn't happen" },
];

const SAFETY_TIPS = [
  "Meet in a public place for your first date",
  "Let a trusted friend know where you're going",
  "Arrange your own transport to and from the venue",
  "Keep your phone charged and accessible",
  "Trust your instincts — it's always okay to leave",
  "Don't share your home address until you're comfortable",
];

// ── Helpers ────────────────────────────────────────────────────────────
function fmt12(t: string) {
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "pm" : "am";
  const hour = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${hour}${m > 0 ? `:${String(m).padStart(2,"0")}` : ""}${ampm}`;
}

function fmtDateLong(s: string) {
  if (!s) return "";
  const d = new Date(s + "T12:00:00");
  return d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

function fmtDateShort(s: string) {
  if (!s) return "";
  const d = new Date(s + "T12:00:00");
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

function buildGoogleCalLink(title: string, dateStr: string, timeStr: string, venue: string) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, mi] = timeStr.split(":").map(Number);
  const start = new Date(y, mo - 1, d, h, mi);
  const end   = new Date(y, mo - 1, d, h + 2, mi);
  const fmt = (dt: Date) =>
    `${dt.getFullYear()}${String(dt.getMonth()+1).padStart(2,"0")}${String(dt.getDate()).padStart(2,"0")}T${String(dt.getHours()).padStart(2,"0")}${String(dt.getMinutes()).padStart(2,"0")}00`;
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${fmt(start)}/${fmt(end)}`,
    details: "Organised with Lulou ❤️",
    location: venue,
  });
  return `https://calendar.google.com/calendar/render?${params}`;
}

function buildICSLink(title: string, dateStr: string, timeStr: string, venue: string) {
  const [y, mo, d] = dateStr.split("-").map(Number);
  const [h, mi] = timeStr.split(":").map(Number);
  const start = new Date(y, mo - 1, d, h, mi);
  const end   = new Date(y, mo - 1, d, h + 2, mi);
  const fmt = (dt: Date) =>
    `${dt.getFullYear()}${String(dt.getMonth()+1).padStart(2,"0")}${String(dt.getDate()).padStart(2,"0")}T${String(dt.getHours()).padStart(2,"0")}${String(dt.getMinutes()).padStart(2,"0")}00`;
  const ics = [
    "BEGIN:VCALENDAR","VERSION:2.0","PRODID:-//Lulou//Date//EN",
    "BEGIN:VEVENT",
    `DTSTART:${fmt(start)}`,
    `DTEND:${fmt(end)}`,
    `SUMMARY:${title}`,
    `LOCATION:${venue}`,
    "DESCRIPTION:Organised with Lulou",
    "END:VEVENT","END:VCALENDAR",
  ].join("\r\n");
  return "data:text/calendar;charset=utf8," + encodeURIComponent(ics);
}

// ── Next N calendar days ───────────────────────────────────────────────
function getNextDays(n: number) {
  const days: { iso: string; label: string; dayName: string }[] = [];
  const today = new Date();
  for (let i = 1; i <= n; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const iso = d.toISOString().split("T")[0];
    const dayName = d.toLocaleDateString("en-GB", { weekday: "short" });
    const label = d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    days.push({ iso, label, dayName });
  }
  return days;
}

// ── Types ──────────────────────────────────────────────────────────────
interface DatePlanState {
  step: "type" | "venue" | "datetime" | "confirming" | "confirmed" | "feedback";
  myVote: string | null;
  theirVote: string | null;
  venueName: string | null;
  venueAddress: string | null;
  venueProposedBy: string | null;
  venueAccepted: boolean;
  proposedDate: string | null;
  proposedTime: string | null;
  datetimeProposedBy: string | null;
  datetimeAccepted: boolean;
  confirmedByMe: boolean;
  confirmedByThem: boolean;
  confirmedAt: string | null;
  myFeedback: string | null;
  theirFeedback: string | null;
  theirName: string;
  theirPhoto: string | null;
  myName: string;
  myPhoto: string | null;
  userId: string;
}

// ── Profile photo helper ───────────────────────────────────────────────
function PhotoCircle({ src, name, size = 56 }: { src: string | null; name: string; size?: number }) {
  const initials = name?.charAt(0)?.toUpperCase() ?? "?";
  return (
    <div
      className="rounded-full overflow-hidden flex items-center justify-center bg-primary/15 text-primary font-semibold shrink-0"
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {src ? (
        <img src={src} alt={name} className="w-full h-full object-cover" />
      ) : (
        initials
      )}
    </div>
  );
}

// ── Step indicator ─────────────────────────────────────────────────────
const STEPS = ["type", "venue", "datetime", "confirming", "confirmed"];
function StepDots({ step }: { step: string }) {
  const idx = STEPS.indexOf(step === "feedback" ? "confirmed" : step);
  return (
    <div className="flex items-center gap-1.5 justify-center py-3">
      {STEPS.map((s, i) => (
        <div
          key={s}
          className={`rounded-full transition-all duration-300 ${
            i === idx
              ? "w-5 h-2 bg-primary"
              : i < idx
              ? "w-2 h-2 bg-primary/40"
              : "w-2 h-2 bg-muted-foreground/20"
          }`}
        />
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 1 — Date Type Vote
// ═══════════════════════════════════════════════════════════════════════
function TypeStep({
  state, matchId,
}: { state: DatePlanState; matchId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [pending, setPending] = useState<string | null>(null);

  const vote = useMutation({
    mutationFn: async (type: string) => {
      const res = await apiRequest("POST", `/api/date-plan/${matchId}/vote`, { type });
      return res.json();
    },
    onMutate: (type) => setPending(type),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/date-plan", matchId] });
    },
    onError: (e: Error) => {
      setPending(null);
      toast({ title: "Couldn't save vote", description: e.message, variant: "destructive" });
    },
    onSettled: () => setPending(null),
  });

  const agreed = state.myVote && state.theirVote && state.myVote === state.theirVote;
  const myType = DATE_TYPES.find(d => d.id === state.myVote);
  const theirType = DATE_TYPES.find(d => d.id === state.theirVote);

  return (
    <div className="dp-fade-up space-y-5">
      <div className="text-center space-y-1">
        <h2 className="text-xl font-serif font-semibold leading-snug">What kind of date?</h2>
        <p className="text-sm text-muted-foreground">
          {state.myVote
            ? state.theirVote
              ? agreed
                ? "You both want the same thing ❤️"
                : "You chose different ideas — chat to agree"
              : `Waiting for ${state.theirName} to vote…`
            : "Pick your favourite idea"}
        </p>
      </div>

      {/* Votes display */}
      {(state.myVote || state.theirVote) && (
        <div className="flex items-center gap-3 justify-center">
          {state.myVote && (
            <div className="flex flex-col items-center gap-1">
              <Badge variant="outline" className="text-sm px-3 py-1 border-primary/30 bg-primary/5">
                {myType?.emoji} {myType?.label}
              </Badge>
              <span className="text-[10px] text-muted-foreground">You</span>
            </div>
          )}
          {state.myVote && state.theirVote && (
            <div className="text-muted-foreground/30 text-lg">vs</div>
          )}
          {state.theirVote && (
            <div className="flex flex-col items-center gap-1">
              <Badge variant="outline" className="text-sm px-3 py-1 border-muted bg-muted/50">
                {theirType?.emoji} {theirType?.label}
              </Badge>
              <span className="text-[10px] text-muted-foreground">{state.theirName}</span>
            </div>
          )}
        </div>
      )}

      {agreed && (
        <div className="dp-pop text-center py-2 px-4 rounded-2xl bg-primary/8 border border-primary/20">
          <p className="text-primary text-sm font-medium">
            {myType?.emoji} Great choice — moving to venue!
          </p>
        </div>
      )}

      {!agreed && (
        <div className="grid grid-cols-2 gap-2.5">
          {DATE_TYPES.map((dt) => {
            const isMyVote = state.myVote === dt.id;
            const isLoading = pending === dt.id;
            return (
              <button
                key={dt.id}
                data-testid={`date-type-${dt.id}`}
                onClick={() => vote.mutate(dt.id)}
                disabled={vote.isPending}
                className={`relative flex items-center gap-3 px-3 py-3 rounded-2xl border transition-all duration-200 text-left
                  ${isMyVote
                    ? "bg-primary/10 border-primary/30 shadow-sm"
                    : "bg-card border-border hover:bg-primary/5 hover:border-primary/20 active:scale-[0.97]"
                  }`}
              >
                <span className="text-2xl leading-none">{dt.emoji}</span>
                <span className={`text-sm font-medium leading-snug ${isMyVote ? "text-primary" : "text-foreground"}`}>
                  {dt.label}
                </span>
                {isMyVote && (
                  <div className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-primary flex items-center justify-center">
                    <svg className="w-2.5 h-2.5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                )}
                {isLoading && (
                  <div className="absolute inset-0 rounded-2xl bg-background/50 flex items-center justify-center">
                    <RefreshCw className="w-4 h-4 text-primary animate-spin" />
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 2 — Venue
// ═══════════════════════════════════════════════════════════════════════
function VenueStep({ state, matchId }: { state: DatePlanState; matchId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [name, setName] = useState("");
  const [addr, setAddr] = useState("");
  const [editing, setEditing] = useState(!state.venueName);

  const propose = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/date-plan/${matchId}/venue`, {
        name: name.trim(), address: addr.trim(),
      });
      return res.json();
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["/api/date-plan", matchId] });
      setEditing(false);
    },
    onError: (e: Error) => toast({ title: "Couldn't save venue", description: e.message, variant: "destructive" }),
  });

  const accept = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/date-plan/${matchId}/venue-accept`, {});
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/date-plan", matchId] }),
    onError: (e: Error) => toast({ title: "Couldn't accept", description: e.message, variant: "destructive" }),
  });

  const iProposed = state.venueProposedBy === state.userId;
  const theyProposed = state.venueProposedBy && !iProposed;

  if (state.venueAccepted) {
    return (
      <div className="dp-fade-up space-y-4">
        <div className="text-center space-y-1">
          <h2 className="text-xl font-serif font-semibold">Venue sorted ✓</h2>
        </div>
        <div className="rounded-2xl bg-primary/6 border border-primary/20 p-4 flex gap-3 items-start">
          <MapPin className="w-4 h-4 text-primary mt-0.5 shrink-0" />
          <div>
            <p className="font-semibold text-sm">{state.venueName}</p>
            {state.venueAddress && <p className="text-xs text-muted-foreground mt-0.5">{state.venueAddress}</p>}
          </div>
          <CheckCircle2 className="w-5 h-5 text-primary shrink-0 ms-auto" />
        </div>
        <p className="text-xs text-center text-muted-foreground">Moving on to picking a date & time…</p>
      </div>
    );
  }

  if (state.venueName && !editing) {
    return (
      <div className="dp-fade-up space-y-4">
        <div className="text-center space-y-1">
          <h2 className="text-xl font-serif font-semibold">
            {iProposed ? `Waiting for ${state.theirName}` : `${state.theirName} suggested a venue`}
          </h2>
          <p className="text-sm text-muted-foreground">
            {iProposed ? "They'll see your suggestion shortly" : "Does this work for you?"}
          </p>
        </div>
        <div className="rounded-2xl bg-card border border-border p-4 space-y-2">
          <div className="flex gap-3 items-start">
            <MapPin className="w-4 h-4 text-primary mt-0.5 shrink-0" />
            <div>
              <p className="font-semibold text-sm">{state.venueName}</p>
              {state.venueAddress && <p className="text-xs text-muted-foreground mt-0.5">{state.venueAddress}</p>}
            </div>
          </div>
        </div>
        {theyProposed && (
          <div className="flex flex-col gap-2">
            <Button onClick={() => accept.mutate()} disabled={accept.isPending} data-testid="button-accept-venue">
              <CheckCircle2 className="w-4 h-4 me-2" />
              {accept.isPending ? "Confirming…" : "Looks perfect!"}
            </Button>
            <Button variant="outline" onClick={() => { setName(state.venueName ?? ""); setAddr(state.venueAddress ?? ""); setEditing(true); }} data-testid="button-change-venue">
              Suggest a different venue
            </Button>
          </div>
        )}
        {iProposed && (
          <Button variant="outline" size="sm" onClick={() => { setName(state.venueName ?? ""); setAddr(state.venueAddress ?? ""); setEditing(true); }} data-testid="button-edit-venue">
            Edit suggestion
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="dp-fade-up space-y-5">
      <div className="text-center space-y-1">
        <h2 className="text-xl font-serif font-semibold">Where shall you go?</h2>
        <p className="text-sm text-muted-foreground">Either of you can suggest a venue</p>
      </div>
      <div className="space-y-3">
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Venue name</label>
          <Input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. The Ivy, Café Luna…"
            maxLength={80}
            data-testid="input-venue-name"
          />
        </div>
        <div>
          <label className="text-xs font-medium text-muted-foreground mb-1.5 block">Area or address (optional)</label>
          <Input
            value={addr}
            onChange={e => setAddr(e.target.value)}
            placeholder="e.g. Soho, London"
            maxLength={120}
            data-testid="input-venue-address"
          />
        </div>
        <Button
          className="w-full"
          onClick={() => propose.mutate()}
          disabled={!name.trim() || propose.isPending}
          data-testid="button-propose-venue"
        >
          <MapPin className="w-4 h-4 me-2" />
          {propose.isPending ? "Saving…" : "Propose this venue"}
        </Button>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 3 — Date & Time
// ═══════════════════════════════════════════════════════════════════════
function DateTimeStep({ state, matchId }: { state: DatePlanState; matchId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const days = useMemo(() => getNextDays(30), []);
  const [selDate, setSelDate] = useState<string>(state.proposedDate ?? "");
  const [selTime, setSelTime] = useState<string>(state.proposedTime ?? "");
  const [editing, setEditing] = useState(!state.proposedDate);
  const scrollRef = useRef<HTMLDivElement>(null);

  const propose = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/date-plan/${matchId}/datetime`, {
        date: selDate, time: selTime,
      });
      return res.json();
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["/api/date-plan", matchId] }); setEditing(false); },
    onError: (e: Error) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  const accept = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/date-plan/${matchId}/datetime-accept`, {});
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/date-plan", matchId] }),
    onError: (e: Error) => toast({ title: "Couldn't accept", description: e.message, variant: "destructive" }),
  });

  const iProposed = state.datetimeProposedBy === state.userId;
  const theyProposed = state.datetimeProposedBy && !iProposed;

  if (state.datetimeAccepted) {
    return (
      <div className="dp-fade-up space-y-4">
        <div className="text-center space-y-1">
          <h2 className="text-xl font-serif font-semibold">Date & time sorted ✓</h2>
        </div>
        <div className="rounded-2xl bg-primary/6 border border-primary/20 p-4 space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <Calendar className="w-4 h-4 text-primary" />
            <span className="font-medium">{fmtDateLong(state.proposedDate!)}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Clock className="w-4 h-4 text-primary" />
            <span className="font-medium">{fmt12(state.proposedTime!)}</span>
          </div>
        </div>
        <p className="text-xs text-center text-muted-foreground">Moving on to final confirmation…</p>
      </div>
    );
  }

  if (state.proposedDate && !editing) {
    return (
      <div className="dp-fade-up space-y-4">
        <div className="text-center space-y-1">
          <h2 className="text-xl font-serif font-semibold">
            {iProposed ? `Waiting for ${state.theirName}` : `${state.theirName} suggested a time`}
          </h2>
          <p className="text-sm text-muted-foreground">
            {iProposed ? "They'll confirm shortly" : "Does this work?"}
          </p>
        </div>
        <div className="rounded-2xl bg-card border border-border p-4 space-y-3">
          <div className="flex items-center gap-2 text-sm">
            <Calendar className="w-4 h-4 text-primary" />
            <span className="font-medium">{fmtDateLong(state.proposedDate)}</span>
          </div>
          <div className="flex items-center gap-2 text-sm">
            <Clock className="w-4 h-4 text-primary" />
            <span className="font-medium">{fmt12(state.proposedTime!)}</span>
          </div>
        </div>
        {theyProposed && (
          <div className="flex flex-col gap-2">
            <Button onClick={() => accept.mutate()} disabled={accept.isPending} data-testid="button-accept-datetime">
              <CheckCircle2 className="w-4 h-4 me-2" />
              {accept.isPending ? "Confirming…" : "That works for me!"}
            </Button>
            <Button variant="outline" onClick={() => { setSelDate(state.proposedDate ?? ""); setSelTime(state.proposedTime ?? ""); setEditing(true); }} data-testid="button-change-datetime">
              Suggest a different time
            </Button>
          </div>
        )}
        {iProposed && (
          <Button variant="outline" size="sm" onClick={() => { setSelDate(state.proposedDate ?? ""); setSelTime(state.proposedTime ?? ""); setEditing(true); }} data-testid="button-edit-datetime">
            Change suggestion
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="dp-fade-up space-y-5">
      <div className="text-center space-y-1">
        <h2 className="text-xl font-serif font-semibold">Pick a date & time</h2>
        <p className="text-sm text-muted-foreground">Either of you can propose</p>
      </div>

      {/* Date picker */}
      <div>
        <p className="text-xs font-medium text-muted-foreground mb-2">Select a day</p>
        <div ref={scrollRef} className="flex gap-2 overflow-x-auto pb-2 -mx-1 px-1 no-scrollbar">
          {days.map(({ iso, label, dayName }) => (
            <button
              key={iso}
              data-testid={`day-${iso}`}
              onClick={() => setSelDate(iso)}
              className={`flex-shrink-0 flex flex-col items-center gap-0.5 px-3 py-2.5 rounded-2xl border transition-all duration-150
                ${selDate === iso
                  ? "bg-primary text-primary-foreground border-primary shadow-md"
                  : "bg-card border-border hover:border-primary/30 hover:bg-primary/5"
                }`}
            >
              <span className={`text-[10px] font-medium ${selDate === iso ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                {dayName}
              </span>
              <span className={`text-sm font-bold ${selDate === iso ? "" : ""}`}>{label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Time picker */}
      {selDate && (
        <div className="dp-fade-up">
          <p className="text-xs font-medium text-muted-foreground mb-2">Select a time</p>
          <div className="grid grid-cols-4 gap-2">
            {TIME_SLOTS.map((t) => (
              <button
                key={t}
                data-testid={`time-${t}`}
                onClick={() => setSelTime(t)}
                className={`py-2 rounded-xl border text-xs font-medium transition-all duration-150
                  ${selTime === t
                    ? "bg-primary text-primary-foreground border-primary shadow-sm"
                    : "bg-card border-border hover:border-primary/30 hover:bg-primary/5"
                  }`}
              >
                {fmt12(t)}
              </button>
            ))}
          </div>
        </div>
      )}

      <Button
        className="w-full"
        onClick={() => propose.mutate()}
        disabled={!selDate || !selTime || propose.isPending}
        data-testid="button-propose-datetime"
      >
        <Calendar className="w-4 h-4 me-2" />
        {propose.isPending ? "Saving…" : "Propose this date & time"}
      </Button>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 4 — Confirming
// ═══════════════════════════════════════════════════════════════════════
function ConfirmingStep({ state, matchId }: { state: DatePlanState; matchId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const typeInfo = DATE_TYPES.find(d => d.id === state.myVote || d.id === state.theirVote);

  const confirm = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", `/api/date-plan/${matchId}/confirm`, {});
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/date-plan", matchId] }),
    onError: (e: Error) => toast({ title: "Couldn't confirm", description: e.message, variant: "destructive" }),
  });

  const bothConfirmed = state.confirmedByMe && state.confirmedByThem;

  return (
    <div className="dp-fade-up space-y-5">
      <div className="text-center space-y-1">
        <h2 className="text-xl font-serif font-semibold">Ready to confirm?</h2>
        <p className="text-sm text-muted-foreground">Both of you need to confirm to lock it in</p>
      </div>

      {/* Summary card */}
      <div className="rounded-3xl border border-border bg-card overflow-hidden shadow-sm">
        {/* Header with avatars */}
        <div className="bg-gradient-to-b from-primary/8 to-transparent px-5 pt-5 pb-3">
          <div className="flex items-center justify-center gap-3">
            <div className="flex flex-col items-center gap-1">
              <PhotoCircle src={state.myPhoto} name={state.myName} size={52} />
              <span className="text-[10px] text-muted-foreground">{state.myName}</span>
            </div>
            <Heart className="w-5 h-5 text-primary dp-pulse-heart" />
            <div className="flex flex-col items-center gap-1">
              <PhotoCircle src={state.theirPhoto} name={state.theirName} size={52} />
              <span className="text-[10px] text-muted-foreground">{state.theirName}</span>
            </div>
          </div>
        </div>

        {/* Details */}
        <div className="px-5 pb-5 space-y-3 pt-1">
          {typeInfo && (
            <div className="flex items-center gap-3 py-2 border-b border-border/50">
              <span className="text-2xl">{typeInfo.emoji}</span>
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Date type</p>
                <p className="text-sm font-semibold">{typeInfo.label}</p>
              </div>
            </div>
          )}
          {state.venueName && (
            <div className="flex items-center gap-3 py-2 border-b border-border/50">
              <MapPin className="w-5 h-5 text-primary shrink-0" />
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Venue</p>
                <p className="text-sm font-semibold">{state.venueName}</p>
                {state.venueAddress && <p className="text-xs text-muted-foreground">{state.venueAddress}</p>}
              </div>
            </div>
          )}
          {state.proposedDate && (
            <div className="flex items-center gap-3 py-2">
              <Calendar className="w-5 h-5 text-primary shrink-0" />
              <div>
                <p className="text-[10px] text-muted-foreground uppercase tracking-wider">Date & time</p>
                <p className="text-sm font-semibold">{fmtDateLong(state.proposedDate)}</p>
                <p className="text-xs text-muted-foreground">{fmt12(state.proposedTime!)}</p>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Confirmation status */}
      <div className="flex items-center gap-3 justify-center">
        <div className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full ${
          state.confirmedByMe ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
        }`}>
          <CheckCircle2 className={`w-3.5 h-3.5 ${state.confirmedByMe ? "" : "opacity-30"}`} />
          {state.myName}
        </div>
        <div className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full ${
          state.confirmedByThem ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
        }`}>
          <CheckCircle2 className={`w-3.5 h-3.5 ${state.confirmedByThem ? "" : "opacity-30"}`} />
          {state.theirName}
        </div>
      </div>

      {!state.confirmedByMe && (
        <Button className="w-full text-base py-6 rounded-2xl shadow-md" onClick={() => confirm.mutate()} disabled={confirm.isPending} data-testid="button-confirm-date">
          <Heart className="w-4 h-4 me-2" />
          {confirm.isPending ? "Confirming…" : "Confirm Date"}
        </Button>
      )}
      {state.confirmedByMe && !state.confirmedByThem && (
        <p className="text-center text-sm text-muted-foreground">
          Waiting for {state.theirName} to confirm…
        </p>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 5 — Confirmed!
// ═══════════════════════════════════════════════════════════════════════
function ConfirmedStep({ state, matchId }: { state: DatePlanState; matchId: string }) {
  const typeInfo = DATE_TYPES.find(d => d.id === state.myVote || d.id === state.theirVote);
  const [showSafety, setShowSafety] = useState(false);

  const dateTitle = `${typeInfo?.label ?? "Date"} with ${state.theirName}`;
  const googleLink = state.proposedDate && state.proposedTime
    ? buildGoogleCalLink(dateTitle, state.proposedDate, state.proposedTime, state.venueName ?? "")
    : null;
  const icsLink = state.proposedDate && state.proposedTime
    ? buildICSLink(dateTitle, state.proposedDate, state.proposedTime, state.venueName ?? "")
    : null;

  // Countdown
  const [countdown, setCountdown] = useState("");
  useEffect(() => {
    if (!state.proposedDate || !state.proposedTime) return;
    const update = () => {
      const target = new Date(`${state.proposedDate}T${state.proposedTime}`);
      const diff = target.getTime() - Date.now();
      if (diff <= 0) { setCountdown("It's time! Enjoy your date 🌟"); return; }
      const days = Math.floor(diff / 86400000);
      const hrs  = Math.floor((diff % 86400000) / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      if (days > 0) setCountdown(`${days}d ${hrs}h to go`);
      else if (hrs > 0) setCountdown(`${hrs}h ${mins}m to go`);
      else setCountdown(`${mins} minutes to go`);
    };
    update();
    const id = setInterval(update, 60000);
    return () => clearInterval(id);
  }, [state.proposedDate, state.proposedTime]);

  const datePassed = state.proposedDate && state.proposedTime
    ? new Date(`${state.proposedDate}T${state.proposedTime}`).getTime() < Date.now()
    : false;

  return (
    <div className="dp-fade-up space-y-5">
      {/* Hero */}
      <div className="text-center space-y-2 pt-2">
        <div className="text-4xl dp-pop">🥂</div>
        <h2 className="text-2xl font-serif font-semibold leading-tight">Your date is confirmed!</h2>
        <p className="text-sm text-muted-foreground">You're both going to have an amazing time</p>
      </div>

      {/* Countdown */}
      {countdown && (
        <div className="text-center">
          <Badge className="text-xs px-4 py-1.5 bg-primary/10 text-primary border-primary/20 font-medium">
            {countdown}
          </Badge>
        </div>
      )}

      {/* Summary */}
      <div className="rounded-3xl border border-primary/20 bg-gradient-to-b from-primary/5 to-transparent p-5 space-y-3">
        {/* Avatars */}
        <div className="flex items-center justify-center gap-3 pb-1">
          <PhotoCircle src={state.myPhoto} name={state.myName} size={44} />
          <Heart className="w-4 h-4 text-primary" />
          <PhotoCircle src={state.theirPhoto} name={state.theirName} size={44} />
        </div>
        {typeInfo && (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-xl">{typeInfo.emoji}</span>
            <span className="font-medium">{typeInfo.label}</span>
          </div>
        )}
        {state.venueName && (
          <div className="flex items-center gap-2 text-sm">
            <MapPin className="w-4 h-4 text-primary shrink-0" />
            <span className="font-medium">{state.venueName}</span>
            {state.venueAddress && <span className="text-muted-foreground text-xs">· {state.venueAddress}</span>}
          </div>
        )}
        {state.proposedDate && (
          <div className="flex items-center gap-2 text-sm">
            <Calendar className="w-4 h-4 text-primary shrink-0" />
            <span className="font-medium">{fmtDateLong(state.proposedDate)}</span>
          </div>
        )}
        {state.proposedTime && (
          <div className="flex items-center gap-2 text-sm">
            <Clock className="w-4 h-4 text-primary shrink-0" />
            <span className="font-medium">{fmt12(state.proposedTime)}</span>
          </div>
        )}
      </div>

      {/* Calendar buttons */}
      {(googleLink || icsLink) && (
        <div className="space-y-2">
          <p className="text-xs font-medium text-muted-foreground text-center">Add to your calendar</p>
          <div className="flex gap-2">
            {icsLink && (
              <a
                href={icsLink}
                download={`${dateTitle}.ics`}
                className="flex-1"
                data-testid="button-add-apple-calendar"
              >
                <Button variant="outline" className="w-full text-sm" size="sm">
                  🍎 Apple Calendar
                </Button>
              </a>
            )}
            {googleLink && (
              <a
                href={googleLink}
                target="_blank"
                rel="noopener noreferrer"
                className="flex-1"
                data-testid="button-add-google-calendar"
              >
                <Button variant="outline" className="w-full text-sm" size="sm">
                  <ExternalLink className="w-3 h-3 me-1.5" />
                  Google Calendar
                </Button>
              </a>
            )}
          </div>
        </div>
      )}

      {/* Safety tips */}
      <div className="rounded-2xl border border-border overflow-hidden">
        <button
          className="w-full flex items-center gap-3 p-4 text-left hover:bg-muted/30 transition-colors"
          onClick={() => setShowSafety(v => !v)}
          data-testid="button-safety-tips"
        >
          <Shield className="w-4 h-4 text-primary shrink-0" />
          <span className="text-sm font-medium flex-1">Safety tips</span>
          {showSafety ? <ChevronUp className="w-4 h-4 text-muted-foreground" /> : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </button>
        {showSafety && (
          <div className="px-4 pb-4 space-y-2 border-t border-border pt-3">
            {SAFETY_TIPS.map((tip, i) => (
              <div key={i} className="flex items-start gap-2.5 text-sm text-muted-foreground">
                <div className="w-1.5 h-1.5 rounded-full bg-primary mt-1.5 shrink-0" />
                {tip}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Post-date feedback prompt — only if date has passed */}
      {datePassed && !state.myFeedback && (
        <div className="dp-pop rounded-2xl border border-primary/20 bg-primary/5 p-4 text-center space-y-3">
          <Sparkles className="w-5 h-5 text-primary mx-auto" />
          <p className="text-sm font-medium">How did it go? 🌟</p>
          <p className="text-xs text-muted-foreground">Let us know how your date went</p>
          <FeedbackInline state={state} matchId={matchId} />
        </div>
      )}

      {/* Both amazing */}
      {state.myFeedback === "amazing" && state.theirFeedback === "amazing" && (
        <div className="dp-pop rounded-3xl border border-amber-200 bg-amber-50 p-5 text-center space-y-3">
          <div className="text-4xl">🏆</div>
          <p className="font-serif font-semibold text-amber-800 text-lg">Amazing connection!</p>
          <p className="text-sm text-amber-700">You both had an amazing time. This is just the beginning!</p>
          <Badge className="bg-amber-100 text-amber-800 border-amber-200 px-4 py-1">✨ Amazing Date Badge</Badge>
        </div>
      )}

      {/* One gave feedback, waiting for other */}
      {state.myFeedback && !(state.myFeedback === "amazing" && state.theirFeedback === "amazing") && (
        <div className="text-center space-y-1">
          <p className="text-xs text-muted-foreground">
            {state.myFeedback === "amazing"
              ? `You had an amazing time! Waiting to see how ${state.theirName} felt…`
              : "Thanks for sharing how it went ❤️"}
          </p>
        </div>
      )}
    </div>
  );
}

// ── Inline feedback (shown on confirmed screen after date passes) ──────
function FeedbackInline({ state, matchId }: { state: DatePlanState; matchId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [sel, setSel] = useState<string | null>(null);

  const submit = useMutation({
    mutationFn: async () => {
      if (!sel) return;
      const res = await apiRequest("POST", `/api/date-plan/${matchId}/feedback`, { rating: sel });
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["/api/date-plan", matchId] }),
    onError: (e: Error) => toast({ title: "Couldn't save", description: e.message, variant: "destructive" }),
  });

  return (
    <div className="space-y-3">
      <div className="flex justify-center gap-2 flex-wrap">
        {FEEDBACK_OPTIONS.map(opt => (
          <button
            key={opt.id}
            data-testid={`feedback-${opt.id}`}
            onClick={() => setSel(opt.id)}
            className={`flex flex-col items-center gap-1 px-3 py-2 rounded-2xl border text-xs transition-all
              ${sel === opt.id ? "bg-primary/10 border-primary/30 text-primary" : "bg-card border-border hover:border-primary/20"}`}
          >
            <span className="text-xl">{opt.emoji}</span>
            <span>{opt.label}</span>
          </button>
        ))}
      </div>
      {sel && (
        <Button size="sm" className="w-full" onClick={() => submit.mutate()} disabled={submit.isPending} data-testid="button-submit-feedback">
          {submit.isPending ? "Saving…" : "Share how it went"}
        </Button>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════
export default function DatePlanPage() {
  const { matchId } = useParams<{ matchId: string }>();
  const [, navigate] = useLocation();
  const { user } = useAuth();

  const { data: state, isLoading, isError, refetch } = useQuery<DatePlanState>({
    queryKey: ["/api/date-plan", matchId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/date-plan/${matchId}`);
      if (!res.ok) throw new Error("Could not load date plan");
      return res.json();
    },
    refetchInterval: 6000,
    staleTime: 3000,
    enabled: !!matchId && !!user,
  });

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Heart className="w-8 h-8 text-primary dp-pulse-heart" />
          <p className="text-sm text-muted-foreground">Setting up your date…</p>
        </div>
      </div>
    );
  }

  if (isError || !state) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-6">
        <div className="text-center space-y-3">
          <p className="font-medium">Couldn't load date plan</p>
          <Button variant="outline" size="sm" onClick={() => refetch()}>Try again</Button>
          <br />
          <Button variant="ghost" size="sm" onClick={() => navigate(`/messages/${matchId}`)}>
            <ArrowLeft className="w-4 h-4 me-2" /> Back to chat
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-border/50">
        <div className="flex items-center gap-3 px-4 py-3 max-w-md mx-auto">
          <button
            onClick={() => navigate(`/messages/${matchId}`)}
            className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-muted transition-colors"
            data-testid="button-back-to-chat"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex-1">
            <h1 className="font-semibold text-base leading-tight">Plan your date</h1>
            <p className="text-xs text-muted-foreground">with {state.theirName}</p>
          </div>
          <div className="flex items-center gap-1.5">
            <PhotoCircle src={state.myPhoto} name={state.myName} size={28} />
            <Heart className="w-3 h-3 text-primary" />
            <PhotoCircle src={state.theirPhoto} name={state.theirName} size={28} />
          </div>
        </div>

        {/* Congratulations banner — only shown at top */}
        {state.step === "type" && (
          <div className="bg-gradient-to-r from-primary/10 via-primary/5 to-primary/10 px-4 py-2.5 text-center">
            <p className="text-sm font-medium text-primary">🎉 Congratulations — you both chose to meet!</p>
          </div>
        )}

        <StepDots step={state.step} />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-md mx-auto px-4 py-5 pb-10">
          {state.step === "type" && <TypeStep state={state} matchId={matchId!} />}
          {state.step === "venue" && <VenueStep state={state} matchId={matchId!} />}
          {state.step === "datetime" && <DateTimeStep state={state} matchId={matchId!} />}
          {state.step === "confirming" && <ConfirmingStep state={state} matchId={matchId!} />}
          {(state.step === "confirmed" || state.step === "feedback") && (
            <ConfirmedStep state={state} matchId={matchId!} />
          )}
        </div>
      </div>
    </div>
  );
}
