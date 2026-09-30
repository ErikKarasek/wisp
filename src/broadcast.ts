// The main window works out what everything is doing; the menu-bar panel and
// the notch only show it. They talk through Tauri events.

import type { MascotCharacter } from "./mascot/mascot";
import type { State } from "./model";

export const EV_STATE = "dispecink-state";
export const EV_REQUEST = "dispecink-state-request";
export const EV_OPEN = "dispecink-open";
export const EV_REFRESH = "dispecink-refresh";

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
};
