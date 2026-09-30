// The user's own setup, saved by the Rust side to config.json in the app's
// config folder: characters, who wears which, renamed items, repos, switches.

import { invoke } from "@tauri-apps/api/core";
import type { MascotCharacter } from "./mascot/mascot";

export type SavedCharacter = { id: string; name: string; character: MascotCharacter };

export type NotchPrefs = {
  /** Pills with the other agents and jobs. */
  showOthers: boolean;
  showMusic: boolean;
  showCalendar: boolean;
  showMirror: boolean;
  /** A character from the gallery for the bot; null for the plain white one. */
  bot: string | null;
  /** Dance while music plays. */
  dance: boolean;
  /** Open for a moment when something happens. */
  peek: boolean;
  /** Eyes follow the mouse. */
  follow: boolean;
  width: "s" | "m" | "l";
  /** Seconds it stays open after the mouse leaves. */
  closeDelay: number;
};

export const NOTCH_WIDTH = { s: 820, m: 960, l: 1100 } as const;

export const defaultNotchPrefs = (): NotchPrefs => ({
  showOthers: true,
  showMusic: true,
  showCalendar: true,
  showMirror: true,
  bot: null,
  dance: true,
  peek: true,
  follow: true,
  width: "l",
  closeDelay: 1.5,
});

export type Config = {
  characters: SavedCharacter[];
  /** Item id → character id. Items without one get their automatic face. */
  assignments: Record<string, string>;
  /** Item id → the name the user gave it. */
  names: Record<string, string>;
  /** Item id → what the user says it does. */
  notes: Record<string, string>;
  /** null until the first discovery of repos with workflows. */
  githubRepos: string[] | null;
  notifications: boolean;
  sounds: boolean;
  /** Claude's and ChatGPT's limits as text next to the menu-bar icon. */
  trayLimits: boolean;
  /** The mascot in the MacBook notch. */
  notch: boolean;
  notchPrefs: NotchPrefs;
  telegram: { enabled: boolean; chat: string };
  /** The bot's morning summary: when, whether to Telegram too, and the last day shown. */
  morning: { enabled: boolean; hour: number; telegram: boolean; last: string };
};

const base = (c: Partial<MascotCharacter>): MascotCharacter => ({
  shape: "round",
  color: "#8b9cff",
  eyeColor: "#111216",
  aspect: 1,
  lean: 0,
  eyeSize: 1,
  eyeSpread: 1,
  ...c,
});

/** A few ready-made characters so there is something to pick from at once. */
const STARTERS: [string, Partial<MascotCharacter>][] = [
  ["Borůvka", { shape: "round", color: "#6d7fe0" }],
  ["Meruňka", { shape: "lemon", color: "#f2a65a" }],
  ["Mech", { shape: "cube", color: "#7fc97a", aspect: 1.1 }],
  ["Obláček", { shape: "cloud", color: "#dfe3ec", aspect: 1.2 }],
  ["Kapka", { shape: "capsule", color: "#4fb3d9", aspect: 0.85 }],
  ["Korál", { shape: "round", color: "#f08a7e", eyeSize: 1.2 }],
  ["Levandule", { shape: "cloud", color: "#b4a1f0" }],
  ["Citron", { shape: "lemon", color: "#e8d25a", lean: -6 }],
  ["Uhlík", { shape: "cube", color: "#3a3f4b", eyeColor: "#f4f5f8" }],
  ["Máta", { shape: "capsule", color: "#5fcfa8", eyeSpread: 1.25 }],
  ["Švestka", { shape: "round", color: "#8e5bb5", eyeColor: "#f4f5f8", aspect: 1.15 }],
  ["Písek", { shape: "cloud", color: "#c9a27e", eyeSize: 0.8 }],
];

export const newId = () => Math.random().toString(36).slice(2, 10);

export function defaults(): Config {
  return {
    characters: STARTERS.map(([name, c]) => ({ id: newId(), name, character: base(c) })),
    assignments: {},
    names: {},
    notes: {},
    githubRepos: null,
    notifications: true,
    sounds: true,
    trayLimits: true,
    notch: true,
    notchPrefs: defaultNotchPrefs(),
    telegram: { enabled: false, chat: "" },
    morning: { enabled: true, hour: 8, telegram: false, last: "" },
  };
}

export function fullCharacter(c: Partial<MascotCharacter>): MascotCharacter {
  return base(c);
}

export async function loadConfig(): Promise<Config> {
  const raw = await invoke<Partial<Config>>("config_load").catch(() => ({}) as Partial<Config>);
  const fresh = !raw || !Array.isArray(raw.characters);
  // Settings added in later versions get their defaults.
  const cfg = { ...defaults(), ...(fresh ? {} : raw) } as Config;
  cfg.notchPrefs = { ...defaultNotchPrefs(), ...(raw?.notchPrefs ?? {}) };
  if (fresh) await saveConfig(cfg);
  return cfg;
}

export async function saveConfig(cfg: Config) {
  await invoke("config_save", { value: cfg });
}
