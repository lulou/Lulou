import React, { useEffect, useState } from "react";
import { getRealtimeCompatibilityEvidence } from "../lib/realtime-compatibility";
import { supabase } from "../lib/supabase";
import { PrivateRealtimeDiagnosticCard } from "./private-realtime-diagnostic";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "./ui/sheet";

/** Mounted only after authorization. Reads the original channel; never changes transport. */
function ExistingPrivateSessionEvidence({ userId }: { userId: string }) {
  const [snapshot, setSnapshot] = useState(() => ({
    evidence: getRealtimeCompatibilityEvidence(userId),
    websocketConnected: supabase.realtime.isConnected(),
  }));
  useEffect(() => {
    const refresh = () => setSnapshot({
      evidence: getRealtimeCompatibilityEvidence(userId),
      websocketConnected: supabase.realtime.isConnected(),
    });
    refresh();
    const interval = window.setInterval(refresh, 1000);
    return () => window.clearInterval(interval);
  }, [userId]);
  return <PrivateRealtimeDiagnosticCard {...snapshot} />;
}

export function TemporaryPrivateRealtimeDiagnostic({
  authorized, open, userId, onClose,
}: {
  authorized: boolean;
  open: boolean;
  userId?: string;
  onClose: () => void;
}) {
  // Do not even read evidence while permission is pending, revoked or mismatched.
  if (!authorized || !open || !userId) return null;
  return (
    <Sheet open onOpenChange={(next) => { if (!next) onClose(); }}>
      <SheetContent side="bottom" className="h-[90dvh] max-h-[90dvh] flex flex-col p-0">
        <SheetHeader className="px-5 pt-5 pb-3 pr-12 border-b shrink-0">
          <SheetTitle>Private Realtime diagnostic</SheetTitle>
          <SheetDescription>Temporary diagnostics for this running device only.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
          <ExistingPrivateSessionEvidence key={userId} userId={userId} />
        </div>
      </SheetContent>
    </Sheet>
  );
}