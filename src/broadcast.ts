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
  ask?: { companyId: string; agentId: string; issueId: string; title: string };
};

export type ClaudeUsage = { session?: { percent: number; resets: string }; week?: { percent: number; resets: string } };

/** One of the ChatGPT subscription's limits: 5 h on Plus and Pro, 30 days on Go. */
export type QuotaWindow = { percent: number; windowSecs: number; resetsAtMs: number };

/** "5 h", "týden", "měsíc": how long a ChatGPT limit window is. */
export function windowName(secs: number): string {
  if (!secs) return "limit";
  if (secs <= 6 * 3600) return `${Math.round(secs / 3600)} h`;
  if (secs <= 8 * 86400) return "týden";
  return "měsíc";
}

export const resetText = (ms: number) =>
  ms ? new Date(ms).toLocaleString("cs-CZ", { day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

/** An Antigravity (Google AI Pro) limit: Gemini models, or its Claude and GPT models. */
export type AgyWindow = { group: "Gemini" | "Claude a GPT"; percent: number; windowSecs: number; resetsAtMs: number };

export type Snapshot = {
  items: MiniItem[];
  counts: { attention: number; run: number; sleep: number; ok: number; off: number };
  /** The item that just changed, for the notch to show when it peeks. */
  news: MiniItem | null;
  at: number;
  /** Agents working right now and their last few steps. */
  live: { id: string; name: string; character: Partial<MascotCharacter>; lines: string[] }[];
  usage: ClaudeUsage | null;
  gpt: QuotaWindow[];
  gemini: AgyWindow[];
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** When a Claude limit resets, from the CLI's "Sep 30 at 11:29pm", "Oct 6 at 7pm" or "11:30pm". */
export function claudeResetMs(text: string, now = Date.now()): number | null {
  const t = /(\d{1,2})(?::(\d{2}))?\s*(am|pm)/i.exec(text);
  if (!t) return null;
  let hour = Number(t[1]) % 12;
  if (t[3].toLowerCase() === "pm") hour += 12;
  const d = new Date(now);
  d.setHours(hour, Number(t[2] ?? 0), 0, 0);
  const md = /([a-z]{3})[a-z]*\s+(\d{1,2})/i.exec(text);
  const month = md ? MONTHS.indexOf(md[1].toLowerCase()) : -1;
  if (md && month >= 0) {
    d.setMonth(month, Number(md[2]));
    if (d.getTime() < now - 86400_000) d.setFullYear(d.getFullYear() + 1);
  } else if (d.getTime() < now) {
    d.setDate(d.getDate() + 1);
  }
  return d.getTime();
}

/** How far into a limit window we are, 0–100, from when it resets and how long it is. */
export function elapsedPercent(resetMs: number | null, windowSecs: number, now = Date.now()): number | null {
  if (!resetMs || !windowSecs) return null;
  const left = (resetMs - now) / (windowSecs * 1000);
  return Math.round(Math.min(1, Math.max(0, 1 - left)) * 100);
}
