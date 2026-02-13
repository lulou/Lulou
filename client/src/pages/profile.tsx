import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Slider } from "@/components/ui/slider";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import {
  MapPin,
  LogOut,
  Flower2,
  Ruler,
  Calendar,
  Radar,
  Crown,
  ShieldCheck,
  Camera,
  HelpCircle,
  Lightbulb,
  ChevronRight,
  BadgeCheck,
} from "lucide-react";
import { DragScrollRow } from "@/components/drag-scroll-row";
import type { Profile } from "@shared/schema";

const DATING_TIPS = [
  { title: "Be Specific in Your Profile", body: "Instead of saying you love travel, mention the trip that changed your perspective. Specificity invites deeper conversation." },
  { title: "Ask Questions That Matter", body: "Skip 'how was your day' and try 'what made you smile today?' Thoughtful questions show genuine interest." },
  { title: "Move to a Call Early", body: "A 10-minute voice call reveals more chemistry than 100 messages. Suggest a call once you feel a spark." },
  { title: "Pick a Specific Date Plan", body: "Instead of 'let's hang out sometime,' suggest a real plan: 'There's a great coffee shop on 5th — Saturday afternoon?'" },
  { title: "Stay Present on Dates", body: "Put your phone away. Make eye contact. The person across from you chose to spend time with you — honour that." },
];

export default function ProfilePage() {
  const { user, logout } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [expandedSection, setExpandedSection] = useState<string | null>(null);
  const [tipIndex, setTipIndex] = useState(0);

  const { data: profile, isLoading } = useQuery<Profile>({
    queryKey: ["/api/profile"],
  });

  const updateRadius = useMutation({
    mutationFn: async (radius: number) => {
      const res = await apiRequest("POST", "/api/profile", { locationRadius: radius });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profile"] });
    },
  });

  const requestVerification = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/profile", { photoVerified: true });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profile"] });
      toast({ title: "Verified!", description: "Your profile now has a verification badge." });
    },
  });

  const toggle = (section: string) => {
    setExpandedSection(prev => prev === section ? null : section);
  };

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

  if (!profile) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-4">
          <Flower2 className="w-12 h-12 text-primary mx-auto" />
          <p className="text-muted-foreground">Profile not found. Complete your onboarding to get started.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5 max-w-lg mx-auto w-full pb-28">
      <div className="flex items-center gap-4">
        <div className="relative">
          <Avatar className="w-20 h-20">
            <AvatarImage src={profile.photos?.[0]} alt={profile.firstName} />
            <AvatarFallback className="bg-primary/10 text-primary text-2xl font-semibold">
              {profile.firstName?.[0]}
            </AvatarFallback>
          </Avatar>
          {profile.photoVerified && (
            <div className="absolute -bottom-1 -right-1 w-6 h-6 bg-primary rounded-full flex items-center justify-center" data-testid="icon-verified-badge">
              <BadgeCheck className="w-4 h-4 text-primary-foreground" />
            </div>
          )}
        </div>
        <div>
          <h1 className="font-serif text-2xl font-bold" data-testid="text-profile-name">
            {profile.firstName}
          </h1>
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
            <span className="flex items-center gap-1" data-testid="text-profile-location">
              <MapPin className="w-3.5 h-3.5" />
              {profile.location}
            </span>
          </div>
        </div>
      </div>

      <Card className="p-4 space-y-2" data-testid="card-radius">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-sm font-medium">
            <Radar className="w-4 h-4 text-primary" />
            Search Radius
          </div>
          <span className="text-sm text-muted-foreground" data-testid="text-radius-value">{profile.locationRadius || 25} miles</span>
        </div>
        <Slider
          value={[profile.locationRadius || 25]}
          onValueChange={([v]) => updateRadius.mutate(v)}
          min={5}
          max={100}
          step={5}
          className="py-1"
          data-testid="slider-profile-radius"
        />
      </Card>

      {profile.photos && profile.photos.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {profile.photos.map((photo, i) => (
            <div key={i} className="aspect-[3/4] rounded-md overflow-hidden">
              <img src={photo} alt={`Photo ${i + 1}`} className="w-full h-full object-cover" data-testid={`img-my-photo-${i}`} />
            </div>
          ))}
        </div>
      )}

      <Card className="p-5 space-y-4">
        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wider uppercase text-primary">Personality Signals</p>
          <DragScrollRow>
            {profile.signals?.map(signal => (
              <Badge key={signal} variant="secondary" className="text-sm py-1.5 px-3 shrink-0 no-default-active-elevate" data-testid={`badge-my-signal-${signal}`}>
                {signal}
              </Badge>
            ))}
          </DragScrollRow>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wider uppercase text-primary">Looking For</p>
          <p className="font-medium" data-testid="text-my-intent">{profile.datingIntent}</p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wider uppercase text-primary">Green Flags</p>
          <DragScrollRow>
            {profile.greenFlags?.map(flag => (
              <Badge key={flag} variant="outline" className="text-sm py-1.5 px-3 shrink-0 no-default-active-elevate" data-testid={`badge-my-flag-${flag}`}>
                {flag}
              </Badge>
            ))}
          </DragScrollRow>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-medium tracking-wider uppercase text-primary">Connection Style</p>
          <p className="font-medium" data-testid="text-my-style">{profile.connectionStyle}</p>
        </div>
      </Card>

      <div className="space-y-2">
        <button
          onClick={() => toggle("extras")}
          className="w-full flex items-center justify-between p-4 rounded-md hover-elevate"
          data-testid="button-bloom-extras"
        >
          <div className="flex items-center gap-3">
            <Crown className="w-5 h-5 text-primary" />
            <div className="text-left">
              <p className="font-medium text-sm">Bloom Extras</p>
              <p className="text-xs text-muted-foreground">Subscriptions & premium features</p>
            </div>
          </div>
          <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${expandedSection === "extras" ? "rotate-90" : ""}`} />
        </button>
        {expandedSection === "extras" && (
          <Card className="p-4 space-y-4" data-testid="section-bloom-extras">
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <p className="font-medium text-sm">Bloom+</p>
                  <p className="text-xs text-muted-foreground">See who opened to you, rewind profiles, priority visibility</p>
                </div>
                <Button size="sm" data-testid="button-subscribe-plus">Subscribe</Button>
              </div>
              <div className="border-t pt-3 flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <p className="font-medium text-sm">Bloom Premium</p>
                  <p className="text-xs text-muted-foreground">Unlimited opens, advanced filters, read receipts, profile boosts</p>
                </div>
                <Button size="sm" data-testid="button-subscribe-premium">Subscribe</Button>
              </div>
            </div>
          </Card>
        )}
      </div>

      <div className="space-y-2">
        <button
          onClick={() => toggle("safety")}
          className="w-full flex items-center justify-between p-4 rounded-md hover-elevate"
          data-testid="button-safety"
        >
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-5 h-5 text-primary" />
            <div className="text-left">
              <p className="font-medium text-sm">Safety</p>
              <p className="text-xs text-muted-foreground">Your wellbeing comes first</p>
            </div>
          </div>
          <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${expandedSection === "safety" ? "rotate-90" : ""}`} />
        </button>
        {expandedSection === "safety" && (
          <Card className="p-4 space-y-3" data-testid="section-safety">
            <div className="space-y-2">
              <p className="font-medium text-sm">Block & Report</p>
              <p className="text-xs text-muted-foreground">You can block or report any user from their profile or your matches. Blocked users cannot see your profile or message you.</p>
            </div>
            <div className="space-y-2">
              <p className="font-medium text-sm">Privacy</p>
              <p className="text-xs text-muted-foreground">Your exact location is never shared. Only your city is visible to others. Photos are stored securely and only shown to active users.</p>
            </div>
            <div className="space-y-2">
              <p className="font-medium text-sm">Safe Dating Tips</p>
              <p className="text-xs text-muted-foreground">Always meet in public, tell a friend where you're going, and trust your instincts. You can leave any conversation at any time.</p>
            </div>
          </Card>
        )}
      </div>

      <div className="space-y-2">
        <button
          onClick={() => toggle("verify")}
          className="w-full flex items-center justify-between p-4 rounded-md hover-elevate"
          data-testid="button-bloom-me"
        >
          <div className="flex items-center gap-3">
            <Camera className="w-5 h-5 text-primary" />
            <div className="text-left">
              <p className="font-medium text-sm">Bloom Me</p>
              <p className="text-xs text-muted-foreground">Photo verification badge</p>
            </div>
          </div>
          <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${expandedSection === "verify" ? "rotate-90" : ""}`} />
        </button>
        {expandedSection === "verify" && (
          <Card className="p-4 space-y-3" data-testid="section-bloom-me">
            {profile.photoVerified ? (
              <div className="flex items-center gap-2">
                <BadgeCheck className="w-5 h-5 text-primary" />
                <p className="text-sm font-medium">You're verified! Your profile displays a badge.</p>
              </div>
            ) : (
              <div className="space-y-3">
                <p className="text-sm text-muted-foreground">Verify your identity by taking a selfie. Verified profiles receive a badge and are trusted more by other users.</p>
                <Button
                  onClick={() => requestVerification.mutate()}
                  disabled={requestVerification.isPending}
                  className="w-full"
                  data-testid="button-verify-photo"
                >
                  <Camera className="w-4 h-4 mr-2" />
                  {requestVerification.isPending ? "Verifying..." : "Verify My Photo"}
                </Button>
              </div>
            )}
          </Card>
        )}
      </div>

      <div className="space-y-2">
        <button
          onClick={() => toggle("help")}
          className="w-full flex items-center justify-between p-4 rounded-md hover-elevate"
          data-testid="button-help-centre"
        >
          <div className="flex items-center gap-3">
            <HelpCircle className="w-5 h-5 text-primary" />
            <div className="text-left">
              <p className="font-medium text-sm">Help Centre</p>
              <p className="text-xs text-muted-foreground">FAQs & support</p>
            </div>
          </div>
          <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${expandedSection === "help" ? "rotate-90" : ""}`} />
        </button>
        {expandedSection === "help" && (
          <Card className="p-4 space-y-3" data-testid="section-help-centre">
            <div className="space-y-2">
              <p className="font-medium text-sm">How does matching work?</p>
              <p className="text-xs text-muted-foreground">When you "Open" to someone and they "Open" to you, it's a match! You can then chat in your matches page.</p>
            </div>
            <div className="space-y-2">
              <p className="font-medium text-sm">Why is messaging limited?</p>
              <p className="text-xs text-muted-foreground">Bloom limits messages to 15 per match to encourage meaningful conversation and moving to real-life meetings sooner.</p>
            </div>
            <div className="space-y-2">
              <p className="font-medium text-sm">How do I delete my account?</p>
              <p className="text-xs text-muted-foreground">Contact our support team and we'll handle it within 24 hours. Your data will be permanently removed.</p>
            </div>
            <div className="space-y-2">
              <p className="font-medium text-sm">I found a bug</p>
              <p className="text-xs text-muted-foreground">Please reach out to us through the app or email support@bloom.dating and we'll look into it right away.</p>
            </div>
          </Card>
        )}
      </div>

      <div className="space-y-2">
        <button
          onClick={() => toggle("tips")}
          className="w-full flex items-center justify-between p-4 rounded-md hover-elevate"
          data-testid="button-what-works"
        >
          <div className="flex items-center gap-3">
            <Lightbulb className="w-5 h-5 text-primary" />
            <div className="text-left">
              <p className="font-medium text-sm">What Works</p>
              <p className="text-xs text-muted-foreground">Expert dating insights</p>
            </div>
          </div>
          <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${expandedSection === "tips" ? "rotate-90" : ""}`} />
        </button>
        {expandedSection === "tips" && (
          <Card className="p-4 space-y-3" data-testid="section-what-works">
            <div className="space-y-1">
              <p className="font-medium text-sm">{DATING_TIPS[tipIndex].title}</p>
              <p className="text-sm text-muted-foreground">{DATING_TIPS[tipIndex].body}</p>
            </div>
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">{tipIndex + 1} of {DATING_TIPS.length}</span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setTipIndex((tipIndex + 1) % DATING_TIPS.length)}
                data-testid="button-next-tip"
              >
                Next Tip
              </Button>
            </div>
          </Card>
        )}
      </div>

      <Button
        variant="outline"
        className="w-full"
        onClick={() => logout()}
        data-testid="button-logout"
      >
        <LogOut className="w-4 h-4 mr-2" /> Sign Out
      </Button>
    </div>
  );
}
