import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Heart, X, Eye, MapPin } from "lucide-react";
import { BloomFlowerIcon } from "@/components/app-layout";
import type { Profile, Interaction } from "@shared/schema";

type IncomingOpen = Interaction & { profile: Profile };

function LikeCard({ open }: { open: IncomingOpen }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const respond = useMutation({
    mutationFn: async (type: "open" | "close") => {
      const res = await apiRequest("POST", "/api/interactions", {
        toUserId: open.fromUserId,
        type,
      });
      return res.json();
    },
    onSuccess: (data: any) => {
      queryClient.invalidateQueries({ queryKey: ["/api/who-liked-you"] });
      queryClient.invalidateQueries({ queryKey: ["/api/matches"] });
      if (data.matched) {
        toast({
          title: "It's a match!",
          description: `You and ${open.profile.firstName} are now connected. Head to Connections to chat.`,
        });
      } else if (data.connectionLimitReached) {
        toast({
          title: "Connection limit reached",
          description: "You have 8 connections. Remove a chat to make room for new ones.",
          variant: "destructive",
        });
      } else {
        toast({ title: "Passed", description: `You passed on ${open.profile.firstName}.` });
      }
    },
    onError: (error: Error) => {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    },
  });

  return (
    <Card className="p-4" data-testid={`card-liked-${open.fromUserId}`}>
      <div className="flex items-start gap-3">
        <Avatar className="w-14 h-14 flex-shrink-0">
          <AvatarImage src={open.profile.photos?.[0]} alt={open.profile.firstName} />
          <AvatarFallback className="bg-primary/10 text-primary font-semibold text-lg">
            {open.profile.firstName?.[0]}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="font-semibold text-sm" data-testid={`text-liked-name-${open.fromUserId}`}>
              {open.profile.firstName}, {open.profile.age}
            </h3>
            {open.profile.photoVerified && (
              <Badge variant="secondary" className="text-xs">Verified</Badge>
            )}
          </div>
          {open.profile.location && (
            <div className="flex items-center gap-1 text-xs text-muted-foreground">
              <MapPin className="w-3 h-3" />
              <span>{open.profile.location}</span>
            </div>
          )}
          <div className="flex items-center gap-1 flex-wrap">
            {open.profile.signals?.slice(0, 2).map((signal: string) => (
              <Badge key={signal} variant="outline" className="text-xs">{signal}</Badge>
            ))}
            {open.profile.datingIntent && (
              <Badge variant="secondary" className="text-xs">{open.profile.datingIntent}</Badge>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <Button
            size="icon"
            variant="ghost"
            onClick={() => respond.mutate("close")}
            disabled={respond.isPending}
            data-testid={`button-pass-${open.fromUserId}`}
          >
            <X className="w-4 h-4 text-muted-foreground" />
          </Button>
          <Button
            size="icon"
            onClick={() => respond.mutate("open")}
            disabled={respond.isPending}
            data-testid={`button-open-back-${open.fromUserId}`}
          >
            <Heart className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

export default function LikesPage() {
  const { data: likes, isLoading } = useQuery<IncomingOpen[]>({
    queryKey: ["/api/who-liked-you"],
    refetchInterval: 15000,
  });

  if (isLoading) {
    return (
      <div className="flex-1 p-6 space-y-4 max-w-lg mx-auto w-full">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64" />
        {[1, 2, 3].map(i => (
          <Skeleton key={i} className="h-20 w-full rounded-md" />
        ))}
      </div>
    );
  }

  const likesList = likes || [];

  if (likesList.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
            <Eye className="w-8 h-8 text-primary" />
          </div>
          <h2 className="font-serif text-2xl font-bold" data-testid="text-no-likes">No likes yet</h2>
          <p className="text-muted-foreground text-sm">
            When someone opens your profile, they'll show up here. Keep your profile fresh to attract more interest.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-5 max-w-lg mx-auto w-full">
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Eye className="w-5 h-5 text-primary" />
            <h1 className="font-serif text-2xl font-bold" data-testid="text-likes-title">Who Liked You</h1>
          </div>
          <Badge variant="secondary" className="text-xs" data-testid="badge-likes-count">
            {likesList.length}
          </Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          These people opened your profile. Open them back to connect, or pass.
        </p>
      </div>

      <div className="space-y-3">
        {likesList.map(open => (
          <LikeCard key={open.id} open={open} />
        ))}
      </div>
    </div>
  );
}
