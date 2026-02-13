import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Avatar, AvatarImage, AvatarFallback } from "@/components/ui/avatar";
import { MessageCircle, Sparkles } from "lucide-react";
import type { Profile, Match } from "@shared/schema";

type MatchWithProfile = Match & { profile: Profile };

export default function Matches() {
  const [, navigate] = useLocation();

  const { data: matches, isLoading } = useQuery<MatchWithProfile[]>({
    queryKey: ["/api/matches"],
  });

  if (isLoading) {
    return (
      <div className="flex-1 p-6 space-y-4">
        <Skeleton className="h-8 w-48" />
        {[1, 2, 3].map(i => (
          <Skeleton key={i} className="h-20 w-full rounded-md" />
        ))}
      </div>
    );
  }

  if (!matches || matches.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-4 max-w-sm">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mx-auto">
            <Sparkles className="w-7 h-7 text-primary" />
          </div>
          <h2 className="font-serif text-2xl font-bold" data-testid="text-no-matches">No matches yet</h2>
          <p className="text-muted-foreground text-sm">
            When you and someone both open up, you'll see them here. Keep discovering.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 p-6 space-y-6 max-w-lg mx-auto w-full">
      <div className="space-y-1">
        <h1 className="font-serif text-2xl font-bold" data-testid="text-matches-title">Your Connections</h1>
        <p className="text-sm text-muted-foreground">{matches.length} mutual {matches.length === 1 ? "connection" : "connections"}</p>
      </div>

      <div className="space-y-3">
        {matches.map(match => (
          <Card
            key={match.id}
            className="p-4 cursor-pointer hover-elevate transition-all"
            onClick={() => navigate(`/messages/${match.id}`)}
            data-testid={`card-match-${match.id}`}
          >
            <div className="flex items-center gap-4">
              <Avatar className="w-14 h-14">
                <AvatarImage src={match.profile.photos?.[0]} alt={match.profile.firstName} />
                <AvatarFallback className="bg-primary/10 text-primary font-semibold">
                  {match.profile.firstName?.[0]}
                </AvatarFallback>
              </Avatar>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <h3 className="font-semibold" data-testid={`text-match-name-${match.id}`}>
                    {match.profile.firstName}, {match.profile.age}
                  </h3>
                  {match.profile.signals?.[0] && (
                    <Badge variant="secondary" className="text-xs">
                      {match.profile.signals[0]}
                    </Badge>
                  )}
                </div>
                <p className="text-sm text-muted-foreground mt-0.5">{match.profile.datingIntent}</p>
              </div>
              <div className="text-muted-foreground/50">
                <MessageCircle className="w-5 h-5" />
              </div>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
