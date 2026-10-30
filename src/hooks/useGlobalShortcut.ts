import { useEffect } from "react";
import {
  register,
  unregister,
} from "@tauri-apps/plugin-global-shortcut";
import { useMeetingStore } from "../stores/meetingStore";
import { useAIActionsStore } from "../stores/aiActionsStore";
import { generateAssist } from "../lib/ipc";
import { showLauncherWindow, showOverlayWindow } from "../lib/windows";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { emitTo, listen } from "@tauri-apps/api/event";
import { useConfigStore } from "../stores/configStore";
import { dispatchMeetingShortcut } from "../lib/meetingShortcut";
import { showToast } from "../stores/toastStore";
import type { GlobalMeetingShortcut, OverlayMeetingShortcut } from "../lib/meetingShortcut";

// Serialize effect setup/cleanup so React Strict Mode cannot unregister a
// newer lease after its registration has already completed.
let shortcutLease = Promise.resolve();

function reportGenerationFailure(error: unknown) {
  const message = error instanceof Error ? error.message
    : typeof error === "string" ? error : "Couldn't generate AI response";
  showToast(message, "error");
}

export function useGlobalShortcut() {
  // Global shortcuts (work even when window is not focused)
  useEffect(() => {
    if (getCurrentWebviewWindow().label !== "launcher") return;
    const shortcuts: string[] = [];
    let cancelled = false;
    let starting = false;

    async function dispatch(command: GlobalMeetingShortcut) {
      if (cancelled || starting || !useConfigStore.getState()._loaded) return;
      const store = useMeetingStore.getState();
      starting = true;
      try {
        await dispatchMeetingShortcut(command, !!store.activeMeeting,
          useConfigStore.getState().rememberedMeetingSetup, {
            start: (audioMode, scenario) => store.startMeetingFlow(undefined, audioMode, scenario),
            overlay: (command) => emitTo("overlay", "nexq:meeting_shortcut", command),
            settings: () => store.setSettingsOpen(!store.settingsOpen),
          });
      } catch (error) {
        console.warn("[shortcuts] Meeting shortcut failed:", error);
      } finally {
        starting = false;
      }
    }

    async function registerShortcuts() {
      // Register each shortcut independently — one failure shouldn't block the rest.
      // Only the launcher registers these process-wide shortcuts.
      const defs: Array<{ key: string; handler: (event: { state: string }) => void }> = [
        {
          key: "CmdOrCtrl+M",
          handler: (event) => {
            if (event.state === "Pressed") {
              void dispatch('toggle-meeting');
            }
          },
        },
        {
          key: "CmdOrCtrl+B",
          handler: (event) => {
            if (event.state === "Pressed") {
              void dispatch('toggle-view');
            }
          },
        },
        {
          key: "CmdOrCtrl+,",
          handler: (event) => {
            if (event.state === "Pressed") {
              void dispatch('toggle-settings');
            }
          },
        },
      ];

      for (const { key, handler } of defs) {
        if (cancelled) break;
        try {
          await unregister(key).catch(() => {}); // Clean up stale registration
          await register(key, handler);
          shortcuts.push(key);
        } catch (err) {
          console.warn(`Failed to register shortcut ${key}:`, err);
        }
      }
    }

    shortcutLease = shortcutLease.then(registerShortcuts);

    return () => {
      cancelled = true;
      shortcutLease = shortcutLease.then(async () => {
        for (const key of shortcuts) await unregister(key).catch(() => {});
      });
    };
  }, []);

  useEffect(() => {
    if (getCurrentWebviewWindow().label !== "overlay") return;
    let cancelled = false;
    let ending = false;
    const subscription = listen<OverlayMeetingShortcut>("nexq:meeting_shortcut", async ({ payload }) => {
      const store = useMeetingStore.getState();
      if (cancelled || !store.activeMeeting) return;
      try {
        if (payload === 'end-meeting') {
          if (ending) return;
          ending = true;
          // The overlay has the AI call log; ending from the launcher loses it.
          try { await store.endMeetingFlow(); } finally { ending = false; }
        } else if (payload === 'toggle-view') {
          if (store.currentView === 'overlay') {
            store.setCurrentView('launcher');
            await showLauncherWindow();
          } else {
            store.setCurrentView('overlay');
            await showOverlayWindow();
          }
        } else if (payload === 'toggle-settings') {
          store.setSettingsOpen(!store.settingsOpen);
        }
      } catch (error) {
        console.warn('[shortcuts] Overlay command failed:', error);
      }
    });
    return () => {
      cancelled = true;
      void subscription.then((unlisten) => unlisten());
    };
  }, []);

  // Window-level shortcuts (work when window is active/focused)
  useEffect(() => {
    if (getCurrentWebviewWindow().label !== "overlay") return;
    function handleKeyDown(e: KeyboardEvent) {
      const store = useMeetingStore.getState();
      if (!store.activeMeeting) return;

      // Don't trigger if user is typing in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      // Check action visibility from the AI actions store
      const actions = useAIActionsStore.getState().configs.actions;
      const isVisible = (mode: string) => actions[mode]?.visible !== false;

      switch (e.code) {
        case "Space":
          if (isVisible("Assist")) {
            e.preventDefault();
            generateAssist("Assist").catch(reportGenerationFailure);
          }
          break;
        case "Numpad1":
        case "Digit1":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("WhatToSay")) {
            e.preventDefault();
            generateAssist("WhatToSay").catch(reportGenerationFailure);
          }
          break;
        case "Numpad2":
        case "Digit2":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("Shorten")) {
            e.preventDefault();
            generateAssist("Shorten").catch(reportGenerationFailure);
          }
          break;
        case "Numpad3":
        case "Digit3":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("FollowUp")) {
            e.preventDefault();
            generateAssist("FollowUp").catch(reportGenerationFailure);
          }
          break;
        case "Numpad4":
        case "Digit4":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("Recap")) {
            e.preventDefault();
            generateAssist("Recap").catch(reportGenerationFailure);
          }
          break;
        case "Numpad5":
        case "Digit5":
          if (!e.ctrlKey && !e.metaKey && !e.altKey && isVisible("AskQuestion")) {
            e.preventDefault();
            // Open/focus the Ask input instead of triggering generation directly
            window.dispatchEvent(new Event("nexq:toggle-ask-input"));
          }
          break;
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
