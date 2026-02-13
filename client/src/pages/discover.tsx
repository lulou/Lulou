import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import type { Profile } from "@shared/schema";
import { MapPin, Sparkles, ChevronLeft, ChevronRight, Heart, X } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";

export default function Discover() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [currentPhotoIndex, setCurrentPhotoIndex] = useState(0);
  const [activeTab, setActiveTab] = useState<"photos" | "about">("photos");

  const { data: profiles, isLoading } = useQuery<Profile[]>({
    queryKey: ["/api/discover"],
  });

  const currentProfile = profiles?.[0];

  const interact = useMutation({
    mutationFn: async (type: "open" | "close") => {
      if (!currentProfile) return;
      const res = await apiRequest("POST", "/api/interactions", {
        toUserId: currentProfile.userId,
        type,
      });
      return res.json();
    },
    onSuccess: (data) => {
      if (data?.matched) {
        toast({
          title: "It's mutual",
          description: `You and ${currentProfile?.firstName} both opened up.`,
        });
      }
      setCurrentPhotoIndex(0);
      setActiveTab("photos");
      queryClient.invalidateQueries({ queryKey: ["/api/discover"] });
    },
  });

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md space-y-4">
          <Skeleton className="aspect-[3/4] w-full rounded-md" />
          <Skeleton className="h-8 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      </div>
    );
  }

  if (!currentProfile) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
            <Sparkles className="w-7 h-7 text-primary" />
          </div>
          <h2 className="font-serif text-2xl font-bold" data-testid="text-no-profiles">That's everyone for now</h2>
          <p className="text-muted-foreground text-sm leading-relaxed">
            Take a breath. New people join Bloom every day. We'll let you know when someone new arrives.
          </p>
        </div>
      </div>
    );
  }

  const photos = currentProfile.photos || [];
  const signals = currentProfile.signals || [];
  const greenFlags = currentProfile.greenFlags || [];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-md mx-auto p-4 md:p-6 space-y-5 pb-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={currentProfile.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -12 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
          >
            <Card className="overflow-hidden" data-testid="card-profile">
              <div className="flex border-b">
                <button
                  className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                    activeTab === "photos"
                      ? "text-primary border-b-2 border-primary"
                      : "text-muted-foreground"
                  }`}
                  onClick={() => setActiveTab("photos")}
                  data-testid="tab-photos"
                >
                  Photos
                </button>
                <button
                  className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                    activeTab === "about"
                      ? "text-primary border-b-2 border-primary"
                      : "text-muted-foreground"
                  }`}
                  onClick={() => setActiveTab("about")}
                  data-testid="tab-about"
                >
                  About
                </button>
              </div>

              {activeTab === "photos" ? (
                <div className="relative aspect-[3/4]" data-testid="profile-photos-section">
                  {photos[currentPhotoIndex] && (
                    <img
                      src={photos[currentPhotoIndex]}
                      alt={currentProfile.firstName}
                      className="w-full h-full object-cover"
                      data-testid="img-profile-photo"
                    />
                  )}
                  <div className="absolute inset-0 bg-gradient-to-t from-black/50 via-transparent to-transparent" />

                  {photos.length > 1 && (
                    <div className="absolute top-3 left-3 right-3 flex gap-1">
                      {photos.map((_, i) => (
                        <div
                          key={i}
                          className={`h-0.5 flex-1 rounded-full transition-colors ${i === currentPhotoIndex ? "bg-white" : "bg-white/30"}`}
                        />
                      ))}
                    </div>
                  )}

                  {currentPhotoIndex > 0 && (
                    <button
                      className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/20 flex items-center justify-center text-white"
                      onClick={() => setCurrentPhotoIndex(i => i - 1)}
                      data-testid="button-photo-prev"
                    >
                      <ChevronLeft className="w-4 h-4" />
                    </button>
                  )}
                  {currentPhotoIndex < photos.length - 1 && (
                    <button
                      className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 rounded-full bg-black/20 flex items-center justify-center text-white"
                      onClick={() => setCurrentPhotoIndex(i => i + 1)}
                      data-testid="button-photo-next"
                    >
                      <ChevronRight className="w-4 h-4" />
                    </button>
                  )}

                  <div className="absolute bottom-0 left-0 right-0 p-5 text-white">
                    <h2 className="font-serif text-2xl font-bold" data-testid="text-profile-name">
                      {currentProfile.firstName}, {currentProfile.age}
                    </h2>
                    <div className="flex items-center gap-1 mt-1 text-white/80 text-sm">
                      <MapPin className="w-3.5 h-3.5" />
                      <span data-testid="text-profile-location">{currentProfile.location}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="p-6 space-y-6 min-h-[300px]" data-testid="profile-about-section">
                  <div className="space-y-1">
                    <h2 className="font-serif text-2xl font-bold" data-testid="text-about-name">
                      {currentProfile.firstName}, {currentProfile.age}
                    </h2>
                    <div className="flex items-center gap-1 text-muted-foreground text-sm">
                      <MapPin className="w-3.5 h-3.5" />
                      <span>{currentProfile.location}</span>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium tracking-wider uppercase text-primary">Personality</p>
                    <div className="flex flex-wrap gap-2">
                      {signals.map(signal => (
                        <Badge key={signal} variant="secondary" className="text-sm py-1.5 px-3">
                          {signal}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium tracking-wider uppercase text-primary">Looking for</p>
                    <p className="font-medium" data-testid="text-profile-intent">{currentProfile.datingIntent}</p>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium tracking-wider uppercase text-primary">Green Flags</p>
                    <div className="flex flex-wrap gap-2">
                      {greenFlags.map(flag => (
                        <Badge key={flag} variant="outline" className="text-sm py-1.5 px-3">
                          {flag}
                        </Badge>
                      ))}
                    </div>
                  </div>

                  <div className="space-y-2">
                    <p className="text-xs font-medium tracking-wider uppercase text-primary">Pace</p>
                    <p className="font-medium" data-testid="text-profile-style">{currentProfile.connectionStyle}</p>
                  </div>
                </div>
              )}
            </Card>

            <div className="flex items-center justify-center gap-5 mt-6">
              <div className="text-center">
                <Button
                  variant="outline"
                  className="w-14 h-14 rounded-full p-0"
                  onClick={() => interact.mutate("close")}
                  disabled={interact.isPending}
                  data-testid="button-close"
                >
                  <X className="w-5 h-5" />
                </Button>
                <p className="text-[11px] text-muted-foreground mt-1.5">Not for me</p>
              </div>
              <div className="text-center">
                <Button
                  className="w-16 h-16 rounded-full p-0"
                  onClick={() => interact.mutate("open")}
                  disabled={interact.isPending}
                  data-testid="button-open"
                >
                  <Heart className="w-6 h-6" />
                </Button>
                <p className="text-[11px] text-muted-foreground mt-1.5">I'm curious</p>
              </div>
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
