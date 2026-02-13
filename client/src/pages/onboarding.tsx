import { useState } from "react";
import { useLocation } from "wouter";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { SIGNALS, GREEN_FLAGS, DATING_INTENTS, CONNECTION_STYLES } from "@shared/schema";
import { Flower2, ArrowRight, ArrowLeft, Check } from "lucide-react";

const STEPS = ["Basics", "Photos", "Signals", "Intent", "Green Flags", "Pace"];

export default function Onboarding() {
  const [step, setStep] = useState(0);
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [formData, setFormData] = useState({
    firstName: "",
    age: 25,
    gender: "",
    datingPreference: "",
    location: "",
    height: "",
    photos: [] as string[],
    signals: [] as string[],
    datingIntent: "",
    greenFlags: [] as string[],
    connectionStyle: "",
  });

  const createProfile = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/profile", {
        ...formData,
        onboardingComplete: true,
      });
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/profile"] });
      navigate("/discover");
    },
    onError: () => {
      toast({ title: "Something went wrong", description: "Please try again.", variant: "destructive" });
    },
  });

  const update = (field: string, value: any) => {
    setFormData(prev => ({ ...prev, [field]: value }));
  };

  const toggleArrayItem = (field: string, item: string, max: number) => {
    setFormData(prev => {
      const arr = (prev as any)[field] as string[];
      if (arr.includes(item)) return { ...prev, [field]: arr.filter(i => i !== item) };
      if (arr.length >= max) return prev;
      return { ...prev, [field]: [...arr, item] };
    });
  };

  const canProceed = () => {
    switch (step) {
      case 0: return formData.firstName && formData.age >= 18 && formData.gender && formData.datingPreference && formData.location;
      case 1: return formData.photos.length >= 2;
      case 2: return formData.signals.length >= 1 && formData.signals.length <= 5;
      case 3: return formData.datingIntent !== "";
      case 4: return formData.greenFlags.length >= 3;
      case 5: return formData.connectionStyle !== "";
      default: return false;
    }
  };

  const handleNext = () => {
    if (step < STEPS.length - 1) setStep(step + 1);
    else createProfile.mutate();
  };

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <div className="px-6 py-5 flex items-center gap-2">
        <Flower2 className="w-5 h-5 text-primary" />
        <span className="font-serif text-lg font-semibold">Bloom</span>
      </div>

      <div className="flex-1 flex items-center justify-center px-6 pb-12">
        <div className="w-full max-w-lg space-y-8">
          <div className="space-y-2">
            <div className="flex items-center gap-2 mb-6">
              {STEPS.map((s, i) => (
                <div
                  key={s}
                  className={`h-1 flex-1 rounded-md transition-colors duration-300 ${i <= step ? "bg-primary" : "bg-muted"}`}
                  data-testid={`progress-step-${i}`}
                />
              ))}
            </div>
            <p className="text-xs font-medium tracking-wider uppercase text-primary">{STEPS[step]}</p>
            <h2 className="font-serif text-2xl font-bold" data-testid="text-step-title">
              {step === 0 && "Tell us about yourself"}
              {step === 1 && "Show who you are"}
              {step === 2 && "Your personality signals"}
              {step === 3 && "What are you looking for?"}
              {step === 4 && "Your green flags"}
              {step === 5 && "Your connection pace"}
            </h2>
            <p className="text-sm text-muted-foreground">
              {step === 0 && "Just the essentials to get started."}
              {step === 1 && "Add at least 2 photos. Clear face photos work best."}
              {step === 2 && "Select up to 5 signals that describe your personality."}
              {step === 3 && "Choose one that reflects your current intentions."}
              {step === 4 && "Pick 3-4 traits that people appreciate about you."}
              {step === 5 && "How do you like to move toward meeting someone?"}
            </p>
          </div>

          <div className="min-h-[280px]">
            {step === 0 && (
              <div className="space-y-5">
                <div className="space-y-2">
                  <Label htmlFor="firstName">First name</Label>
                  <Input
                    id="firstName"
                    value={formData.firstName}
                    onChange={e => update("firstName", e.target.value)}
                    placeholder="Your first name"
                    data-testid="input-first-name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="age">Age</Label>
                  <Input
                    id="age"
                    type="number"
                    min={18}
                    max={99}
                    value={formData.age}
                    onChange={e => update("age", parseInt(e.target.value) || 18)}
                    data-testid="input-age"
                  />
                </div>
                <div className="space-y-2">
                  <Label>Gender</Label>
                  <Select value={formData.gender} onValueChange={v => update("gender", v)}>
                    <SelectTrigger data-testid="select-gender"><SelectValue placeholder="Select gender" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="woman">Woman</SelectItem>
                      <SelectItem value="man">Man</SelectItem>
                      <SelectItem value="non-binary">Non-binary</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>Interested in</Label>
                  <Select value={formData.datingPreference} onValueChange={v => update("datingPreference", v)}>
                    <SelectTrigger data-testid="select-dating-preference"><SelectValue placeholder="Who do you want to date?" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="women">Women</SelectItem>
                      <SelectItem value="men">Men</SelectItem>
                      <SelectItem value="everyone">Everyone</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="location">Location</Label>
                  <Input
                    id="location"
                    value={formData.location}
                    onChange={e => update("location", e.target.value)}
                    placeholder="City, State"
                    data-testid="input-location"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="height">Height (optional)</Label>
                  <Input
                    id="height"
                    value={formData.height}
                    onChange={e => update("height", e.target.value)}
                    placeholder="e.g. 5'8&quot;"
                    data-testid="input-height"
                  />
                </div>
              </div>
            )}

            {step === 1 && (
              <div className="space-y-4">
                <div className="grid grid-cols-3 gap-3">
                  {[0, 1, 2, 3, 4, 5].map(i => (
                    <PhotoSlot
                      key={i}
                      index={i}
                      photo={formData.photos[i]}
                      onSelect={(url) => {
                        const newPhotos = [...formData.photos];
                        if (newPhotos[i]) {
                          newPhotos[i] = url;
                        } else {
                          newPhotos.push(url);
                        }
                        update("photos", newPhotos);
                      }}
                      onRemove={() => {
                        update("photos", formData.photos.filter((_, idx) => idx !== i));
                      }}
                    />
                  ))}
                </div>
                <p className="text-xs text-muted-foreground text-center">
                  {formData.photos.length}/6 photos added (minimum 2)
                </p>
              </div>
            )}

            {step === 2 && (
              <div className="flex flex-wrap gap-2">
                {SIGNALS.map(signal => (
                  <Badge
                    key={signal}
                    variant={formData.signals.includes(signal) ? "default" : "outline"}
                    className={`cursor-pointer text-sm py-2 px-4 transition-all ${
                      formData.signals.includes(signal) ? "bg-primary text-primary-foreground" : ""
                    }`}
                    onClick={() => toggleArrayItem("signals", signal, 5)}
                    data-testid={`badge-signal-${signal.toLowerCase().replace(/\s+/g, "-")}`}
                  >
                    {formData.signals.includes(signal) && <Check className="w-3 h-3 mr-1" />}
                    {signal}
                  </Badge>
                ))}
                <p className="w-full text-xs text-muted-foreground mt-2">
                  {formData.signals.length}/5 selected
                </p>
              </div>
            )}

            {step === 3 && (
              <div className="space-y-3">
                {DATING_INTENTS.map(intent => (
                  <Card
                    key={intent}
                    className={`p-5 cursor-pointer transition-all hover-elevate ${
                      formData.datingIntent === intent ? "border-primary bg-primary/5" : ""
                    }`}
                    onClick={() => update("datingIntent", intent)}
                    data-testid={`card-intent-${intent.toLowerCase().replace(/\s+/g, "-")}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{intent}</span>
                      {formData.datingIntent === intent && (
                        <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                          <Check className="w-3 h-3 text-primary-foreground" />
                        </div>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}

            {step === 4 && (
              <div className="flex flex-wrap gap-2">
                {GREEN_FLAGS.map(flag => (
                  <Badge
                    key={flag}
                    variant={formData.greenFlags.includes(flag) ? "default" : "outline"}
                    className={`cursor-pointer text-sm py-2 px-4 transition-all ${
                      formData.greenFlags.includes(flag) ? "bg-primary text-primary-foreground" : ""
                    }`}
                    onClick={() => toggleArrayItem("greenFlags", flag, 4)}
                    data-testid={`badge-flag-${flag.toLowerCase().replace(/\s+/g, "-")}`}
                  >
                    {formData.greenFlags.includes(flag) && <Check className="w-3 h-3 mr-1" />}
                    {flag}
                  </Badge>
                ))}
                <p className="w-full text-xs text-muted-foreground mt-2">
                  {formData.greenFlags.length}/4 selected (minimum 3)
                </p>
              </div>
            )}

            {step === 5 && (
              <div className="space-y-3">
                {CONNECTION_STYLES.map(style => (
                  <Card
                    key={style}
                    className={`p-5 cursor-pointer transition-all hover-elevate ${
                      formData.connectionStyle === style ? "border-primary bg-primary/5" : ""
                    }`}
                    onClick={() => update("connectionStyle", style)}
                    data-testid={`card-style-${style.toLowerCase().replace(/\s+/g, "-")}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{style}</span>
                      {formData.connectionStyle === style && (
                        <div className="w-5 h-5 rounded-full bg-primary flex items-center justify-center">
                          <Check className="w-3 h-3 text-primary-foreground" />
                        </div>
                      )}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>

          <div className="flex items-center justify-between gap-4 pt-4">
            {step > 0 ? (
              <Button variant="ghost" onClick={() => setStep(step - 1)} data-testid="button-back">
                <ArrowLeft className="w-4 h-4 mr-2" /> Back
              </Button>
            ) : <div />}
            <Button
              onClick={handleNext}
              disabled={!canProceed() || createProfile.isPending}
              data-testid="button-next"
            >
              {step === STEPS.length - 1 ? (
                createProfile.isPending ? "Creating..." : "Complete Profile"
              ) : (
                <>Continue <ArrowRight className="w-4 h-4 ml-2" /></>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PhotoSlot({ index, photo, onSelect, onRemove }: {
  index: number;
  photo?: string;
  onSelect: (url: string) => void;
  onRemove: () => void;
}) {
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      onSelect(reader.result as string);
    };
    reader.readAsDataURL(file);
  };

  return (
    <div className="relative aspect-[3/4] rounded-md bg-muted border-2 border-dashed border-muted-foreground/20 overflow-hidden group" data-testid={`photo-slot-${index}`}>
      {photo ? (
        <>
          <img src={photo} alt={`Photo ${index + 1}`} className="w-full h-full object-cover" />
          <button
            onClick={onRemove}
            className="absolute top-1 right-1 w-6 h-6 rounded-full bg-background/80 flex items-center justify-center text-xs text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity"
            style={{ visibility: photo ? "visible" : "hidden" }}
            data-testid={`button-remove-photo-${index}`}
          >
            x
          </button>
        </>
      ) : (
        <label className="flex items-center justify-center w-full h-full cursor-pointer text-muted-foreground/40 text-2xl font-light">
          +
          <input type="file" accept="image/*" onChange={handleFileChange} className="hidden" data-testid={`input-photo-${index}`} />
        </label>
      )}
    </div>
  );
}
