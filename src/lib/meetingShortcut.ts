import type { AudioMode, AIScenario } from './types';

export type GlobalMeetingShortcut = 'toggle-meeting' | 'toggle-view' | 'toggle-settings';
export type OverlayMeetingShortcut = 'end-meeting' | 'toggle-view' | 'toggle-settings';
type Setup = { audioMode: AudioMode; scenario: AIScenario };

/** The launcher owns OS shortcuts; the live overlay owns ending/persistence. */
export async function dispatchMeetingShortcut(
  command: GlobalMeetingShortcut,
  hasMeeting: boolean,
  setup: Setup | null,
  actions: {
    start: (audioMode?: AudioMode, scenario?: AIScenario) => Promise<void>;
    overlay: (command: OverlayMeetingShortcut) => Promise<void>;
    settings: () => void;
  },
): Promise<void> {
  if (command === 'toggle-meeting') {
    if (hasMeeting) await actions.overlay('end-meeting');
    else await actions.start(setup?.audioMode, setup?.scenario);
  } else if (hasMeeting) {
    await actions.overlay(command);
  } else if (command === 'toggle-settings') {
    actions.settings();
  }
}
