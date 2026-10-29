// Runs meeting-critical hooks at the App level so they persist
// even when the user navigates away from the overlay view.
// This ensures transcription, timers, and persistence continue
// in the background regardless of which page is displayed.
//
// Two-window architecture: launcher handles transcript persistence/audio;
// overlay owns response capture and end-of-meeting answer persistence.

import { useMeetingStore } from "../stores/meetingStore";
import { useMeetingTimer } from "../hooks/useMeetingTimer";
import { useTranscriptPersistence } from "../hooks/useTranscriptPersistence";
import { useTranscript } from "../hooks/useTranscript";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";
import { useAudioConfigSync } from "../hooks/useAudioConfigSync";
import { useStreamBuffer } from "../hooks/useStreamBuffer";
import { useCallLogCapture } from "../hooks/useCallLogCapture";
import { useSTTStatus } from "../hooks/useSTTStatus";
import { useDevLog } from "../hooks/useDevLog";

export function ActiveMeetingProvider({ isLauncherWindow = true }: { isLauncherWindow?: boolean }) {
  const activeMeeting = useMeetingStore((s) => s.activeMeeting);

  if (!activeMeeting) return null;

  // Overlay window: display and response history (no audio control)
  if (!isLauncherWindow) return <OverlayMeetingHooks />;

  return <LauncherMeetingHooks />;
}

// Overlay window: live display and answer log from Tauri events
function OverlayMeetingHooks() {
  useMeetingTimer();
  useTranscript();    // transcript_final/update → local store
  useStreamBuffer();  // AI streaming events → local store
  useCallLogCapture(); // completed answers → local log + SQLite
  useSTTStatus();     // STT connection status
  useDevLog();        // debug log entries
  return null;
}

// Launcher window: persistence + audio control (hidden during meeting)
function LauncherMeetingHooks() {
  useMeetingTimer();
  useTranscript();         // also subscribe here so persistence hook sees segments
  useSpeechRecognition();  // web speech API (emits cross-window events for overlay)
  useAudioConfigSync();    // hot-swap STT/audio config
  useTranscriptPersistence(); // transcript store → SQLite DB
  useStreamBuffer();
  useSTTStatus();
  useDevLog();
  return null;
}
