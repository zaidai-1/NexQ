import assert from 'node:assert/strict';
import { dispatchMeetingShortcut } from '../src/lib/meetingShortcut.ts';

const calls = [];
const ports = {
  start: async (...args) => calls.push(['start', ...args]),
  overlay: async command => calls.push(['overlay', command]),
  settings: () => calls.push(['settings']),
};
const saved = { audioMode: 'online', scenario: 'interview' };
await dispatchMeetingShortcut('toggle-meeting', false, saved, ports);
assert.deepEqual(calls.splice(0), [['start', 'online', 'interview']]);
await dispatchMeetingShortcut('toggle-meeting', true, saved, ports);
assert.deepEqual(calls.splice(0), [['overlay', 'end-meeting']]);
await dispatchMeetingShortcut('toggle-view', true, saved, ports);
await dispatchMeetingShortcut('toggle-settings', true, saved, ports);
assert.deepEqual(calls.splice(0), [['overlay', 'toggle-view'], ['overlay', 'toggle-settings']]);
await dispatchMeetingShortcut('toggle-view', false, saved, ports);
assert.deepEqual(calls.splice(0), []);
await dispatchMeetingShortcut('toggle-settings', false, saved, ports);
assert.deepEqual(calls.splice(0), [['settings']]);
await dispatchMeetingShortcut('toggle-meeting', false, null, ports);
assert.deepEqual(calls.splice(0), [['start', undefined, undefined]]);
console.log('Meeting shortcut routing regression checks passed.');
