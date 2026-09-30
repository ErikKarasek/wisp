// The main window works out what everything is doing; the menu-bar panel and
// the notch only show it. They talk through Tauri events.

import type { MascotCharacter } from "./mascot/mascot";
import type { State } from "./model";

export const EV_STATE = "dispecink-state";
export const EV_REQUEST = "dispecink-state-request";
export const EV_OPEN = "dispecink-open";
export const EV_REFRESH = "dispecink-refresh";
/** The notch's settings changed; it reloads them. */
export const EV_NOTCH_PREFS = "dispecink-notch-prefs";
/** Open the main window on its settings. */
export const EV_OPEN_SETTINGS = "dispecink-open-settings";

export type MiniItem = {
  id: string;
  name: string;
  state: State;
  chip: string;
  doing: string;
  when: string;
  where: string;
  character: Partial<MascotCharacter>;
};

export type Snapshot = {
  items: MiniItem[];
  counts: { attention: number; run: number; sleep: number; ok: number; off: number };
  /** The item that just changed, for the notch to show when it peeks. */
  news: MiniItem | null;
  at: number;
  /** Agents working right now and their last few steps. */
  live: { id: string; name: string; character: Partial<MascotCharacter>; lines: string[] }[];
};
