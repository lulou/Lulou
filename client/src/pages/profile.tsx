import { useState, useRef } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
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
  Settings,
  CreditCard,
  ArrowLeft,
  Pencil,
  Plus,
  X,
  ImagePlus,
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
  const [purchaseItem, setPurchaseItem] = useState<{ name: string; price: string; type: "subscription" | "one-time" } | null>(null);

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

  const [editingPhotos, setEditingPhotos] = useState(false);
  const [editPhotos, setEditPhotos] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const startEditingPhotos = () => {
    setEditPhotos([...(profile?.photos || [])]);
    setEditingPhotos(true);
  };

  const cancelEditingPhotos = () => {
    setEditingPhotos(false);
    setEditPhotos([]);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    Array.from(files).forEach(file => {
      if (editPhotos.length >= 6) return;
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        setEditPhotos(prev => prev.length < 6 ? [...prev, result] : prev);
      };
      reader.readAsDataURL(file);
    });
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const removeEditPhoto = (index: number) => {
    setEditPhotos(prev => prev.filter((_, i) => i !== index));
  };

  const savePhotos = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/profile", { photos: editPhotos });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profile"] });
      toast({ title: "Photos updated" });
      setEditingPhotos(false);
      setEditPhotos([]);
    },
    onError: () => {
      toast({ title: "Could not save photos", variant: "destructive" });
    },
  });

  const [settingsForm, setSettingsForm] = useState<Record<string, string | undefined>>({});

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
      const res = await apiRequest("POST", "/api/profile", settingsForm);
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profile"] });
      toast({ title: "Settings saved" });
      setExpandedSection(null);
    },
  });

  const toggle = (section: string) => {
    if (section === "settings" && expandedSection !== "settings") {
      initSettings();
    }
    setPurchaseItem(null);
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
        <div className="flex-1">
          <div className="flex items-center justify-between gap-2">
            <h1 className="font-serif text-2xl font-bold" data-testid="text-profile-name">
              {profile.firstName}
            </h1>
            <Button size="icon" variant="ghost" onClick={() => toggle("settings")} data-testid="button-settings-icon">
              <Settings className="w-5 h-5" />
            </Button>
          </div>
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

      {expandedSection === "settings" && (
        <Card className="p-5 space-y-4" data-testid="section-settings">
          <p className="font-medium text-sm">Settings</p>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="settings-location" className="text-xs">Location</Label>
              <Input
                id="settings-location"
                value={settingsForm.location || ""}
                onChange={e => setSettingsForm(prev => ({ ...prev, location: e.target.value }))}
                placeholder="City, State"
                data-testid="input-settings-location"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="settings-height" className="text-xs">Height</Label>
              <Input
                id="settings-height"
                value={settingsForm.height || ""}
                onChange={e => setSettingsForm(prev => ({ ...prev, height: e.target.value }))}
                placeholder="e.g. 5'8&quot;"
                data-testid="input-settings-height"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Who you want to date</Label>
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
                  <SelectItem value="everyone">Everyone</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Dating intent</Label>
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
              <Label className="text-xs">Connection style</Label>
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
            {saveSettings.isPending ? "Saving..." : "Save Changes"}
          </Button>
        </Card>
      )}

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

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <p className="text-xs font-medium tracking-wider uppercase text-muted-foreground">Photos</p>
          {!editingPhotos ? (
            <Button size="sm" variant="ghost" onClick={startEditingPhotos} data-testid="button-edit-photos">
              <Pencil className="w-3.5 h-3.5 mr-1.5" /> Edit Photos
            </Button>
          ) : (
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

        {editingPhotos ? (
          <div className="grid grid-cols-3 gap-2">
            {editPhotos.map((photo, i) => (
              <div key={i} className="aspect-[3/4] rounded-md overflow-hidden relative group">
                <img src={photo} alt={`Photo ${i + 1}`} className="w-full h-full object-cover" data-testid={`img-edit-photo-${i}`} />
                <button
                  onClick={() => removeEditPhoto(i)}
                  className="absolute top-1 right-1 w-6 h-6 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center invisible group-hover:visible"
                  data-testid={`button-remove-photo-${i}`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
            {editPhotos.length < 6 && (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="aspect-[3/4] rounded-md border-2 border-dashed border-muted-foreground/30 flex flex-col items-center justify-center gap-1 hover-elevate transition-colors"
                data-testid="button-add-photo"
              >
                <ImagePlus className="w-6 h-6 text-muted-foreground/50" />
                <span className="text-xs text-muted-foreground/50">Add</span>
              </button>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleFileSelect}
              data-testid="input-photo-file"
            />
          </div>
        ) : profile.photos && profile.photos.length > 0 ? (
          <div className="grid grid-cols-3 gap-2">
            {profile.photos.map((photo, i) => (
              <div key={i} className="aspect-[3/4] rounded-md overflow-hidden">
                <img src={photo} alt={`Photo ${i + 1}`} className="w-full h-full object-cover" data-testid={`img-my-photo-${i}`} />
              </div>
            ))}
          </div>
        ) : (
          <button
            onClick={startEditingPhotos}
            className="w-full aspect-[3/4] max-w-[140px] rounded-md border-2 border-dashed border-muted-foreground/30 flex flex-col items-center justify-center gap-1 hover-elevate"
            data-testid="button-add-first-photo"
          >
            <ImagePlus className="w-8 h-8 text-muted-foreground/50" />
            <span className="text-xs text-muted-foreground/50">Add photos</span>
          </button>
        )}
      </div>

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
              <p className="text-xs text-muted-foreground">Individual extras & membership</p>
            </div>
          </div>
          <ChevronRight className={`w-4 h-4 text-muted-foreground transition-transform ${expandedSection === "extras" ? "rotate-90" : ""}`} />
        </button>
        {expandedSection === "extras" && !purchaseItem && (
          <Card className="p-4 space-y-4" data-testid="section-bloom-extras">
            <div className="space-y-1 pb-2">
              <p className="font-medium text-sm">Bloom Membership</p>
              <p className="text-xs text-muted-foreground">Everything you need for deeper connections</p>
            </div>
            <div className="rounded-md border p-3 space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <p className="font-medium text-sm">$19.99/month</p>
                <Button size="sm" onClick={() => setPurchaseItem({ name: "Bloom Membership", price: "$19.99/month", type: "subscription" })} data-testid="button-subscribe-membership">Join</Button>
              </div>
              <ul className="text-xs text-muted-foreground space-y-1">
                <li>2 conversation extensions per month</li>
                <li>1 extra call</li>
                <li>1 video call</li>
                <li>2 extra spins per week</li>
                <li>Undo last close</li>
              </ul>
            </div>

            <div className="pt-2 space-y-1">
              <p className="font-medium text-sm">Solo Extras</p>
              <p className="text-xs text-muted-foreground">One-time purchases</p>
            </div>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <p className="text-sm">+5 Messages</p>
                  <p className="text-xs text-muted-foreground">Give a conversation more room</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setPurchaseItem({ name: "+5 Messages", price: "$4.99", type: "one-time" })} data-testid="button-buy-messages">$4.99</Button>
              </div>
              <div className="border-t pt-2 flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <p className="text-sm">Undo Last Close</p>
                  <p className="text-xs text-muted-foreground">Changed your mind? Reopen that profile</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setPurchaseItem({ name: "Undo Last Close", price: "$2.99", type: "one-time" })} data-testid="button-buy-undo">$2.99</Button>
              </div>
              <div className="border-t pt-2 flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <p className="text-sm">Extra Call</p>
                  <p className="text-xs text-muted-foreground">One more voice call with a match</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setPurchaseItem({ name: "Extra Call", price: "$4.99", type: "one-time" })} data-testid="button-buy-call">$4.99</Button>
              </div>
              <div className="border-t pt-2 flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <p className="text-sm">Video Call</p>
                  <p className="text-xs text-muted-foreground">See each other face to face</p>
                </div>
                <Button size="sm" variant="outline" onClick={() => setPurchaseItem({ name: "Video Call", price: "$6.99", type: "one-time" })} data-testid="button-buy-video">$6.99</Button>
              </div>
            </div>
          </Card>
        )}

        {expandedSection === "extras" && purchaseItem && (
          <Card className="p-5 space-y-5" data-testid="section-payment">
            <div className="flex items-center gap-2">
              <Button size="icon" variant="ghost" onClick={() => setPurchaseItem(null)} data-testid="button-payment-back">
                <ArrowLeft className="w-4 h-4" />
              </Button>
              <p className="font-medium text-sm">Payment</p>
            </div>

            <div className="rounded-md border p-4 space-y-1">
              <p className="font-medium text-sm" data-testid="text-payment-item">{purchaseItem.name}</p>
              <p className="text-lg font-bold text-primary" data-testid="text-payment-price">{purchaseItem.price}</p>
              <p className="text-xs text-muted-foreground">
                {purchaseItem.type === "subscription" ? "Billed monthly. Cancel anytime." : "One-time purchase."}
              </p>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-medium tracking-wider uppercase text-muted-foreground">Payment Method</p>
              <div className="space-y-2">
                <button
                  className="w-full flex items-center gap-3 p-3 rounded-md border hover-elevate text-left"
                  data-testid="button-pay-card"
                  onClick={() => toast({ title: "Payment processing coming soon", description: "Card payments will be available shortly." })}
                >
                  <CreditCard className="w-5 h-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">Credit or Debit Card</p>
                    <p className="text-xs text-muted-foreground">Visa, Mastercard, Amex</p>
                  </div>
                </button>
                <button
                  className="w-full flex items-center gap-3 p-3 rounded-md border hover-elevate text-left"
                  data-testid="button-pay-apple"
                  onClick={() => toast({ title: "Payment processing coming soon", description: "Apple Pay will be available shortly." })}
                >
                  <div className="w-5 h-5 flex items-center justify-center text-muted-foreground font-bold text-sm">A</div>
                  <div>
                    <p className="text-sm font-medium">Apple Pay</p>
                    <p className="text-xs text-muted-foreground">Fast and secure checkout</p>
                  </div>
                </button>
                <button
                  className="w-full flex items-center gap-3 p-3 rounded-md border hover-elevate text-left"
                  data-testid="button-pay-google"
                  onClick={() => toast({ title: "Payment processing coming soon", description: "Google Pay will be available shortly." })}
                >
                  <div className="w-5 h-5 flex items-center justify-center text-muted-foreground font-bold text-sm">G</div>
                  <div>
                    <p className="text-sm font-medium">Google Pay</p>
                    <p className="text-xs text-muted-foreground">Fast and secure checkout</p>
                  </div>
                </button>
              </div>
            </div>

            <p className="text-xs text-center text-muted-foreground">Payments are secure and encrypted. You can cancel subscriptions at any time from your profile.</p>
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
