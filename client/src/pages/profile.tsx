import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/use-auth";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { MapPin, LogOut, Flower2 } from "lucide-react";
import { DragScrollRow } from "@/components/drag-scroll-row";
import type { Profile } from "@shared/schema";

export default function ProfilePage() {
  const { user, logout } = useAuth();

  const { data: profile, isLoading } = useQuery<Profile>({
    queryKey: ["/api/profile"],
  });

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
    <div className="flex-1 overflow-y-auto p-6 space-y-6 max-w-lg mx-auto w-full">
      <div className="flex items-center gap-4">
        <Avatar className="w-20 h-20">
          <AvatarImage src={profile.photos?.[0]} alt={profile.firstName} />
          <AvatarFallback className="bg-primary/10 text-primary text-2xl font-semibold">
            {profile.firstName?.[0]}
          </AvatarFallback>
        </Avatar>
        <div>
          <h1 className="font-serif text-2xl font-bold" data-testid="text-profile-name">
            {profile.firstName}, {profile.age}
          </h1>
          <div className="flex items-center gap-1 text-muted-foreground text-sm mt-1">
            <MapPin className="w-3.5 h-3.5" />
            <span data-testid="text-profile-location">{profile.location}</span>
          </div>
        </div>
      </div>

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
