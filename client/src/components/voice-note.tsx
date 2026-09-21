import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Loader2, Pause, Play, RotateCcw, Mic } from "lucide-react";

type VoiceStatus = "sending" | "failed" | undefined;

const waveform = [4, 7, 11, 8, 14, 9, 6, 12, 16, 10, 7, 13, 9, 5, 11, 15, 8, 6, 12, 9, 14, 7, 5, 10, 13, 8, 6, 11, 15, 9, 5, 8];
let activePause: (() => void) | null = null;

function safeSourceKind(url: string) {
  return url.startsWith("blob:") ? "blob" : url.startsWith("https:") ? "https" : "other";
}

function logPlayback(event: string, audio: HTMLAudioElement, url: string) {
  const error = audio.error;
  console.info("[VOICE_NOTE_PLAYBACK]", {
    event,
    errorCode: error?.code ?? null,
    networkState: audio.networkState,
    readyState: audio.readyState,
    sourceKind: safeSourceKind(url),
    mime: audio.currentSrc ? audio.getAttribute("type") ?? null : null,
  });
}

function formatDuration(value: number) {
  const seconds = Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function VoiceNote({
  url, isMe, transcript, status, onRetry, onLoadStateChange, recordedDuration,
}: {
  url: string;
  isMe: boolean;
  transcript?: string | null;
  status?: VoiceStatus;
  onRetry?: () => void;
  onLoadStateChange?: (state: string, url: string) => void;
  recordedDuration?: number;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const retryingRef = useRef(false);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [showTranscript, setShowTranscript] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const transcriptEnabled = typeof window !== "undefined" && localStorage.getItem("audio_transcripts") === "true";
  const progress = duration ? Math.min(1, currentTime / duration) : 0;
  const bars = useMemo(() => waveform, []);
  const pause = useCallback(() => { audioRef.current?.pause(); }, []);

  useEffect(() => {
    retryingRef.current = false;
    setPlaying(false); setCurrentTime(0); setDuration(0); setError(false); setUnavailable(false);
    onLoadStateChange?.("loading", url);
  }, [url, reloadKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    if (activePause === pause) activePause = null;
  }, [pause]);

  const retryMedia = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (activePause && activePause !== pause) activePause();
    activePause = pause;
    retryingRef.current = true;
    audio.pause();
    audio.src = url;
    audio.load();
    setError(false);
    onLoadStateChange?.("loading", url);
    logPlayback("play_attempt", audio, url);
    audio.play().then(() => {
      retryingRef.current = false;
      logPlayback("play_success", audio, url);
    }).catch((reason: DOMException) => {
      retryingRef.current = false;
      logPlayback(reason?.name === "NotAllowedError" ? "play_blocked_permission" : "play_failure", audio, url);
      if (activePause === pause) activePause = null;
      setError(true);
      setUnavailable(true);
      onLoadStateChange?.("error", url);
    });
  };

  const toggle = () => {
    const audio = audioRef.current;
    if (status === "failed") { onRetry?.(); return; }
    if (unavailable) return;
    if (error) { retryMedia(); return; }
    if (!audio) return;
    if (!audio.paused) { audio.pause(); return; }
    if (activePause && activePause !== pause) activePause();
    activePause = pause;
    logPlayback("play_attempt", audio, url);
    audio.play().then(() => logPlayback("play_success", audio, url)).catch((reason: DOMException) => {
      logPlayback(reason?.name === "NotAllowedError" ? "play_blocked_permission" : "play_failure", audio, url);
      if (activePause === pause) activePause = null;
      setError(true); onLoadStateChange?.("error", url);
    });
  };

  return (
    <div className="voice-note-wrap">
      <div className={`voice-note ${isMe ? "voice-note-outgoing" : "voice-note-incoming"}`} data-testid="voice-note-bubble">
        <audio
          key={reloadKey}
          ref={audioRef}
          src={url}
          preload="metadata"
          onLoadedMetadata={event => {
            const value = event.currentTarget.duration;
            setDuration(Number.isFinite(value) ? value : 0);
            setUnavailable(false);
            onLoadStateChange?.("ready", url);
          }}
          onTimeUpdate={event => setCurrentTime(event.currentTarget.currentTime)}
          onPlay={() => setPlaying(true)}
          onPause={() => { setPlaying(false); if (activePause === pause) activePause = null; }}
          onEnded={() => { setPlaying(false); setCurrentTime(0); if (activePause === pause) activePause = null; }}
          onError={event => {
            logPlayback("media_error", event.currentTarget, url);
            if (activePause === pause) activePause = null;
            setError(true);
            if (retryingRef.current) setUnavailable(true);
            onLoadStateChange?.("error", url);
          }}
        />
        <button type="button" className="voice-note-control" onClick={toggle} disabled={unavailable} aria-label={unavailable ? "Voice note unavailable" : status === "failed" || error ? "Retry voice note" : playing ? "Pause voice note" : "Play voice note"}>
          {status === "failed" || error ? <RotateCcw className="h-4 w-4" /> : playing ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
        </button>
        <div className="voice-note-track">
          <div className="voice-note-wave" aria-hidden="true">
            {bars.map((height, index) => <span key={index} style={{ height: `${height}px`, opacity: index / bars.length <= progress ? 1 : 0.38 }} />)}
          </div>
          <div className="voice-note-meta">
            <span>{unavailable ? "Voice note unavailable" : status === "failed" ? "Tap to retry" : error ? "Tap to reload" : status === "sending" ? "Sending" : duration > 0 ? formatDuration(playing ? currentTime : duration) : recordedDuration ? formatDuration(recordedDuration) : "Processing"}</span>
            {(status === "sending" || (!duration && !recordedDuration && !error)) && <Loader2 className="h-3 w-3 animate-spin" />}
          </div>
        </div>
        <Mic className="voice-note-mark h-3.5 w-3.5" />
      </div>
      {transcriptEnabled && transcript && (
        <button type="button" className="voice-note-transcript-toggle" onClick={() => setShowTranscript(value => !value)}>
          <ChevronDown className={`h-3 w-3 ${showTranscript ? "rotate-180" : ""}`} /> {showTranscript ? "Hide transcript" : "Show transcript"}
        </button>
      )}
      {transcriptEnabled && transcript && showTranscript && <div className="voice-note-transcript">“{transcript}”</div>}
    </div>
  );
}