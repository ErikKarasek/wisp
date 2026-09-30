// Turns what launchd and Paperclip report into characters: who they are, what
// they are doing, and how they feel about it.

import type { ExpressionName, MascotCharacter, MascotShape } from "./mascot/mascot";
import { cronEvery, nextCron } from "./cron";
import { ago, ahead, cronInWords, duration, nextCalendar, type CalendarTime } from "./time";

export type State = "run" | "ok" | "done" | "sleep" | "you" | "new" | "bad" | "off";

export const STATES: Record<State, { expr: ExpressionName; chip: string; label: string }> = {
  run: { expr: "thriving", chip: "pracuje", label: "Pracuje" },
  ok: { expr: "happy", chip: "v pořádku", label: "V pořádku" },
  done: { expr: "proud", chip: "hotovo", label: "Hotovo" },
  sleep: { expr: "sleepy", chip: "spí", label: "Spí do dalšího běhu" },
  you: { expr: "curious", chip: "čeká na tebe", label: "Čeká na tebe" },
  new: { expr: "surprised", chip: "něco našel", label: "Něco našel" },
  bad: { expr: "angry", chip: "selhal", label: "Selhal" },
  off: { expr: "sad", chip: "vypnutý", label: "Vypnutý" },
};

/** Worst first: what the tray face and the sort order care about. */
export const SEVERITY: State[] = ["bad", "you", "new", "run", "done", "ok", "sleep", "off"];

export type Command =
  | { type: "job"; label: string; action: "run" | "restart" | "pause" | "resume" }
  | { type: "paperclip"; kind: "agentPause" | "agentResume" | "agentInvoke" | "routineRun"; id: string }
  | { type: "github"; repo: string; workflowId: number; action: "run" | "enable" | "disable" }
  | { type: "editJob"; label: string }
  | { type: "editAgent"; companyId: string; agentId: string }
  | { type: "editRoutine"; companyId: string; routineId?: string }
  | { type: "open"; target: string };

export type ActionSpec = {
  label: string;
  primary?: boolean;
  /** Asked on the button itself before it runs. */
  confirm?: string;
  command: Command;
};

export type Item = {
  id: string;
  group: string;
  name: string;
  doing: string;
  /** What it is for, when that differs from what it is doing right now. */
  about?: string;
  /** An agent waiting on Erik: the task it is stuck on, so he can answer it. */
  ask?: { companyId: string; agentId: string; issueId: string; title: string };
  when: string;
  state: State;
  chip?: string;
  bubble?: string;
  /** Agents: the subscription they run on. */
  engine?: "Claude" | "ChatGPT";
  character: Partial<MascotCharacter>;
  facts: [string, string][];
  /** A job's log label, an agent's live runs, or static lines to show instead. */
  log: { job: string } | { agent: { companyId: string; agentId: string } } | { lines: string[] } | null;
  actions: ActionSpec[];
};

export type Group = {
  id: string;
  title: string;
  note: string;
  items: Item[];
  notice?: string;
  /** Paperclip groups: the company, so a new agent can be hired into it. */
  company?: { id: string; name: string; prefix: string };
};

// ---------- characters ----------

const SHAPES: MascotShape[] = ["round", "capsule", "lemon", "cube", "cloud"];
const PALETTE = ["#6d7fe0", "#d980c9", "#e0935a", "#4fb3d9", "#b4a1f0", "#e8c46a", "#8fd694", "#f08a7e", "#5fcfa8", "#c9a27e"];

function hash(s: string) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Everyone keeps the same face forever: known ones by hand, the rest by name. */
export function characterFor(key: string): Partial<MascotCharacter> {
  const known = CHARACTERS[key];
  if (known) return known;
  const h = hash(key);
  return { shape: SHAPES[h % SHAPES.length], color: PALETTE[(h >>> 8) % PALETTE.length] };
}

const CHARACTERS: Record<string, Partial<MascotCharacter>> = {
  "com.erikkarasek.devlog": { shape: "capsule", color: "#6d7fe0" },
  "com.erikkarasek.github-reels": { shape: "cloud", color: "#d980c9" },
  "com.erikkarasek.job-mail": { shape: "round", color: "#e0935a" },
  "com.erikkarasek.job-mail-bot": { shape: "lemon", color: "#4fb3d9" },
  "com.erikkarasek.job-digest": { shape: "cube", color: "#b4a1f0" },
  "com.erikkarasek.openterminal": { shape: "capsule", color: "#5fcfa8" },
  "ing.paperclip.paperclipai": { shape: "cloud", color: "#c9a27e" },
  "agent:Watcher": { shape: "round", color: "#e8c46a" },
  "agent:Dispatcher": { shape: "capsule", color: "#8fd694" },
  "agent:Fixer": { shape: "cube", color: "#f08a7e" },
  "agent:karel": { shape: "lemon", color: "#9ec1ff" },
  "cf:site-watch": { shape: "round", color: "#5fcfa8" },
  "cf:job-tracker-scout": { shape: "lemon", color: "#f2a65a" },
  "cf:github-reels": { shape: "cloud", color: "#e7a3dc" },
};

// ---------- launchd ----------

type Schedule =
  | { kind: "calendar"; times: CalendarTime[] }
  | { kind: "interval"; seconds: number }
  | { kind: "keepAlive" }
  | { kind: "onLoad" }
  | { kind: "manual" };

export type Job = {
  label: string;
  plistPath: string;
  program: string[];
  schedule: Schedule;
  loaded: boolean;
  disabled: boolean;
  running: boolean;
  pid: number | null;
  uptimeSecs: number | null;
  runs: number | null;
  lastExit: number | null;
  lastSignal: string | null;
  logPath: string | null;
  logModifiedMs: number | null;
  lastLogLine: string | null;
  managed: boolean;
  command: string | null;
  workingDir: string | null;
};

const JOBS: Record<string, { name: string; doing: string }> = {
  "com.erikkarasek.devlog": { name: "Devlog", doing: "V noci sepíše, co se za den commitlo" },
  "com.erikkarasek.github-reels": { name: "GitHub reels", doing: "Ráno projde trendy a AI novinky a napíše scénáře reelů" },
  "com.erikkarasek.job-digest": { name: "Job digest", doing: "Pošle souhrn nových nabídek práce" },
  "com.erikkarasek.job-mail": { name: "Job mail", doing: "Každou hodinu projde poštu kvůli odpovědím na přihlášky" },
  "com.erikkarasek.job-mail-bot": { name: "Telegram bot", doing: "Poslouchá tlačítka v Telegramu a zakládá karty" },
  "com.erikkarasek.openterminal": { name: "OpenTerminal", doing: "Tržní terminál, spouští se ručně" },
  "ing.paperclip.paperclipai": { name: "Paperclip", doing: "Server, na kterém běží agenti" },
};

const RECENT_MS = 10 * 60_000;
const longRunning = (s: Schedule) => s.kind === "keepAlive" || s.kind === "onLoad" || s.kind === "manual";

function scheduleText(s: Schedule): string {
  switch (s.kind) {
    case "calendar":
      return s.times
        .map((t) => (t.hour == null ? `každou hodinu v :${String(t.minute ?? 0).padStart(2, "0")}` : `denně ${t.hour}:${String(t.minute ?? 0).padStart(2, "0")}`))
        .join(", ");
    case "interval":
      return `každých ${duration(s.seconds)}`;
    case "keepAlive":
      return "běží pořád";
    case "onLoad":
      return "po přihlášení";
    case "manual":
      return "ručně";
  }
}

function nextRun(j: Job, now: number): number | null {
  if (j.schedule.kind === "calendar") return nextCalendar(j.schedule.times, now);
  if (j.schedule.kind === "interval" && j.logModifiedMs) {
    const next = j.logModifiedMs + j.schedule.seconds * 1000;
    return next > now ? next : null;
  }
  return null;
}

export function jobItem(j: Job, now = Date.now()): Item {
  const info = JOBS[j.label] ?? { name: j.label.replace(/^com\.erikkarasek\./, ""), doing: j.command ?? j.program.join(" ") };
  const last = j.logModifiedMs;
  const next = nextRun(j, now);
  const whenParts: string[] = [];

  let state: State;
  let chip: string | undefined;
  let bubble: string | undefined;
  let doing = info.doing;

  if (!j.loaded || j.disabled) {
    state = "off";
    chip = "vypnutá";
  } else if (j.running) {
    state = longRunning(j.schedule) ? "ok" : "run";
    chip = longRunning(j.schedule) ? "běží" : undefined;
    if (j.uptimeSecs != null) whenParts.push(`běží ${duration(j.uptimeSecs)}`);
  } else if (j.lastExit != null && j.lastExit !== 0) {
    state = "bad";
    bubble = `kód ${j.lastExit}`;
    doing = j.lastLogLine ?? `Skončila s kódem ${j.lastExit}`;
  } else if (j.schedule.kind === "keepAlive") {
    state = "bad";
    bubble = "neběží";
    doing = "Má běžet pořád, ale neběží";
  } else if (last && now - last < RECENT_MS) {
    state = "done";
    bubble = "hotovo!";
  } else {
    state = "sleep";
  }

  if (!j.running && last) whenParts.push(`naposledy ${ago(last, now)}`);
  if (state !== "off" && next) whenParts.push(`příště ${ahead(next, now)}`);
  if (!whenParts.length) whenParts.push(scheduleText(j.schedule));

  const actions: ActionSpec[] = [];
  if (state !== "off") {
    if (j.running && longRunning(j.schedule)) {
      actions.push({ label: "Restartovat", primary: true, confirm: "Opravdu restartovat?", command: { type: "job", label: j.label, action: "restart" } });
    } else if (!j.running) {
      actions.push({ label: "Spustit teď", primary: true, command: { type: "job", label: j.label, action: "run" } });
    }
    actions.push({ label: "Pozastavit", confirm: "Opravdu vypnout? Zůstane vypnutá i po restartu Macu.", command: { type: "job", label: j.label, action: "pause" } });
  } else {
    actions.push({ label: "Zapnout", primary: true, command: { type: "job", label: j.label, action: "resume" } });
  }
  if (j.logPath) actions.push({ label: "Otevřít log", command: { type: "open", target: j.logPath } });
  if (j.managed) actions.push({ label: "Upravit", command: { type: "editJob", label: j.label } });

  const facts: [string, string][] = [
    ["Rozvrh", scheduleText(j.schedule)],
    ["Spuštění", j.runs != null ? String(j.runs) : "–"],
  ];
  if (j.pid) facts.push(["PID", String(j.pid)]);
  if (j.lastExit != null) facts.push(["Poslední kód", String(j.lastExit)]);
  facts.push(["Úloha", j.label]);

  return {
    id: `job:${j.label}`,
    group: "mac",
    name: info.name,
    doing,
    about: info.doing,
    when: whenParts.join(" · "),
    state,
    chip,
    bubble,
    character: characterFor(j.label),
    facts,
    log: j.logPath ? { job: j.label } : null,
    actions,
  };
}

// ---------- Paperclip ----------

type Obj = Record<string, any>;
export type PaperclipSnapshot =
  | { online: false; error: string }
  | { online: true; baseUrl: string; companies: { company: Obj; agents: Obj[]; routines: Obj[]; issues: Obj[] }[] };

const OPEN_WORK = new Set(["todo", "in_progress", "in_review", "backlog"]);
const ms = (s: unknown) => (typeof s === "string" ? Date.parse(s) : NaN);

function agentItem(a: Obj, issues: Obj[], groupId: string, now: number): Item {
  const mine = issues.filter((i) => i.assigneeAgentId === a.id);
  const blocked = mine.find((i) => i.status === "blocked");
  const active = mine.find((i) => i.status === "in_progress") ?? mine.find((i) => OPEN_WORK.has(i.status));
  const paused = a.status === "paused" || !!a.pausedAt;

  let state: State;
  let chip: string | undefined;
  let bubble: string | undefined;
  let ask: Item["ask"];
  let doing = a.title ?? "Agent";

  if (paused) {
    state = "off";
    chip = "pozastavený";
  } else if (a.status === "error") {
    state = "bad";
    bubble = "chyba";
    doing = a.errorReason ?? "Poslední běh selhal";
  } else if (a.status === "running") {
    state = "run";
    if (active) doing = `${active.identifier}: ${active.title}`;
  } else if (blocked) {
    state = "you";
    bubble = "?";
    doing = `${blocked.identifier}: ${blocked.title}`;
    ask = { companyId: a.companyId, agentId: a.id, issueId: blocked.id, title: `${blocked.identifier}: ${blocked.title}` };
  } else if (active) {
    state = "ok";
    chip = "má úkol";
    doing = `${active.identifier}: ${active.title}`;
  } else {
    state = "sleep";
    chip = "nemá úkol";
  }

  const last = ms(a.lastHeartbeatAt);
  const when = Number.isNaN(last) ? "zatím neběžel" : `naposledy ${ago(last, now)}`;
  const spent = typeof a.spentMonthlyCents === "number" ? a.spentMonthlyCents / 100 : null;
  const budget = typeof a.budgetMonthlyCents === "number" && a.budgetMonthlyCents > 0 ? a.budgetMonthlyCents / 100 : null;

  const actions: ActionSpec[] = [];
  if (!paused) {
    if (state !== "run") {
      actions.push({
        label: "Probudit",
        primary: true,
        confirm: `Spustí agenta přes tvoje ${a.adapterType === "codex_local" ? "ChatGPT" : "Claude"} předplatné. Pokračovat?`,
        command: { type: "paperclip", kind: "agentInvoke", id: a.id },
      });
    }
    actions.push({ label: "Pozastavit", command: { type: "paperclip", kind: "agentPause", id: a.id } });
  } else {
    actions.push({ label: "Obnovit", primary: true, command: { type: "paperclip", kind: "agentResume", id: a.id } });
  }
  actions.push({ label: "Upravit", command: { type: "editAgent", companyId: a.companyId, agentId: a.id } });

  const facts: [string, string][] = [["Role", a.title ?? "–"], ["Motor", a.adapterType === "codex_local" ? "ChatGPT" : "Claude"]];
  if (a.adapterConfig?.model) facts.push(["Model", a.adapterConfig.model]);
  if (spent != null) facts.push(["Tento měsíc", budget ? `$${spent.toFixed(2)} z $${budget.toFixed(0)}` : `$${spent.toFixed(2)}`]);

  const tasks = mine.map((i) => `${i.identifier} · ${i.title}`).join(", ");

  return {
    id: `agent:${a.id}`,
    group: groupId,
    name: a.name,
    doing,
    when,
    state,
    chip,
    bubble,
    engine: a.adapterType === "codex_local" ? "ChatGPT" : "Claude",
    character: characterFor(`agent:${a.name}`),
    facts: tasks ? [...facts, ["Úkoly", tasks]] : facts,
    log: { agent: { companyId: a.companyId, agentId: a.id } },
    ask,
    actions,
  };
}

function routineItem(r: Obj, agents: Obj[], groupId: string, now: number): Item {
  const agent = agents.find((a) => a.id === r.assigneeAgentId);
  const triggers: Obj[] = (r.triggers ?? []).filter((t: Obj) => t.enabled);
  const nexts = triggers.map((t) => ms(t.nextRunAt)).filter((n) => !Number.isNaN(n));
  const next = nexts.length ? Math.min(...nexts) : null;
  const lastRun: Obj | null = r.lastRun ?? null;
  const last = lastRun ? ms(lastRun.completedAt ?? lastRun.triggeredAt) : NaN;
  const schedule = triggers.map((t) => (t.cronExpression ? cronInWords(t.cronExpression) : t.kind)).join(", ");

  let state: State;
  let bubble: string | undefined;
  let doing = `${agent ? agent.name : "Agent"} · ${schedule || "jen ručně"}`;

  if (r.status === "paused" || r.status === "archived") {
    state = "off";
  } else if (r.activeIssue && !["done", "cancelled"].includes(r.activeIssue.status)) {
    state = "run";
    doing = `${agent ? agent.name : "Agent"} na tom právě pracuje`;
  } else if (lastRun?.status === "failed") {
    state = "bad";
    bubble = "selhala";
    doing = lastRun.failureReason ?? "Poslední běh selhal";
  } else if (!Number.isNaN(last) && now - last < RECENT_MS) {
    state = "done";
    bubble = "hotovo!";
  } else {
    state = "sleep";
  }

  const whenParts: string[] = [];
  if (!Number.isNaN(last)) whenParts.push(`naposledy ${ago(last, now)}`);
  if (next && state !== "off") whenParts.push(`příště ${ahead(next, now)}`);

  const actions: ActionSpec[] = [];
  if (state !== "off" && state !== "run") {
    actions.push({
      label: "Spustit teď",
      primary: true,
      confirm: "Spustí rutinu přes tvoje Claude předplatné. Pokračovat?",
      command: { type: "paperclip", kind: "routineRun", id: r.id },
    });
  }
  actions.push({ label: "Upravit", command: { type: "editRoutine", companyId: r.companyId, routineId: r.id } });

  return {
    id: `routine:${r.id}`,
    group: groupId,
    name: r.title,
    doing,
    when: whenParts.join(" · ") || "zatím neběžela",
    state,
    chip: state === "sleep" ? "čeká" : undefined,
    bubble,
    ...(agent ? { engine: agent.adapterType === "codex_local" ? ("ChatGPT" as const) : ("Claude" as const) } : {}),
    character: characterFor(`routine:${r.title}`),
    facts: [
      ["Kdo", agent?.name ?? "–"],
      ["Kdy", schedule || "ručně"],
      ["Poslední běh", lastRun ? `${lastRun.status}${lastRun.linkedIssue ? ` (${lastRun.linkedIssue.identifier})` : ""}` : "–"],
    ],
    log: { lines: (r.description ?? "").split("\n").filter(Boolean) },
    actions,
  };
}

export function paperclipGroups(snap: PaperclipSnapshot, now = Date.now()): Group[] {
  if (!snap.online) {
    return [{ id: "paperclip", title: "Paperclip", note: "agenti", items: [], notice: "Paperclip neodpovídá. Agenti teď nepoběží." }];
  }
  // A company with nobody in it has nothing to show.
  return snap.companies.filter((c) => c.agents.length || c.routines.length).map(({ company, agents, routines, issues }) => {
    const id = `paperclip:${company.id}`;
    const prefix = company.issuePrefix ?? "";
    return {
      id,
      title: "Paperclip",
      note: company.name,
      company: { id: company.id, name: company.name, prefix },
      items: [
        ...agents.map((a) => agentItem(a, issues, id, now)),
        ...routines.map((r) => routineItem(r, agents, id, now)),
      ],
    };
  });
}

export function macGroup(jobs: Job[], now = Date.now()): Group {
  return { id: "mac", title: "Mac", note: "launchd", items: jobs.map((j) => jobItem(j, now)) };
}

// ---------- Cloudflare ----------

type Part<T> = { ok: T } | { error: string };
export type CloudflareSnapshot =
  | { configured: false }
  | { configured: true; error: string; account?: string }
  | {
      configured: true;
      account: string;
      workers: { name: string; modifiedOn: string; schedules: { cron: string }[] }[];
      invocations: Part<{ sum: { requests: number; errors: number }; dimensions: { scriptName: string } }[]>;
      cronEvents: Part<{ scriptName: string; cron: string; status: string; datetime: string }[]>;
      neurons: Part<{ sum: { totalNeurons: number } }[]>;
    };

const WORKERS: Record<string, string> = {
  "site-watch": "Hlídá weby a hlásí výpadky do Telegramu",
  "job-tracker-scout": "Ráno hledá nové nabídky práce",
  "github-reels": "Webová appka s reely",
  opengym: "OpenGym",
  "subscription-tracker": "Hlídá předplatná",
  lolstats: "Statistiky z League of Legends",
};

export const NEURONS_PER_DAY = 10_000;

export function cloudflareNeurons(snap: CloudflareSnapshot): number | null {
  if (!snap.configured || !("workers" in snap) || !("ok" in snap.neurons)) return null;
  return snap.neurons.ok?.[0]?.sum?.totalNeurons ?? 0;
}

export function cloudflareGroup(snap: CloudflareSnapshot, now = Date.now()): Group | null {
  if (!snap.configured) {
    return { id: "cloudflare", title: "Cloudflare", note: "Workers", items: [], notice: "Přidej token v Nastavení a uvidíš tu svoje Workery." };
  }
  if (!("workers" in snap)) {
    return { id: "cloudflare", title: "Cloudflare", note: "Workers", items: [], notice: `Cloudflare neodpovídá: ${snap.error}` };
  }
  const inv = "ok" in snap.invocations ? snap.invocations.ok ?? [] : [];
  const events = "ok" in snap.cronEvents ? snap.cronEvents.ok ?? [] : [];
  const problems = [snap.invocations, snap.cronEvents].filter((p) => "error" in p).map((p) => (p as { error: string }).error);

  const items = snap.workers.map((w): Item => {
    const stats = inv.filter((i) => i.dimensions.scriptName === w.name);
    const requests = stats.reduce((n, i) => n + i.sum.requests, 0);
    const errors = stats.reduce((n, i) => n + i.sum.errors, 0);
    const lastCron = events.find((e) => e.scriptName === w.name);
    const crons = w.schedules.map((s) => s.cron);
    const nexts = crons.map((c) => nextCron(c, true, now)).filter((n): n is number => n != null);
    const next = nexts.length ? Math.min(...nexts) : null;
    const lastMs = lastCron ? Date.parse(lastCron.datetime) : NaN;

    let state: State;
    let chip: string | undefined;
    let bubble: string | undefined;
    let doing = WORKERS[w.name] ?? "Worker";
    if (lastCron && lastCron.status !== "success") {
      state = "bad";
      bubble = "cron selhal";
      doing = `Poslední cron skončil: ${lastCron.status}`;
    } else if (errors > 0) {
      state = "you";
      bubble = `${errors} chyb`;
      doing = `${errors} chyb z ${requests} běhů za 24 h`;
    } else if (!Number.isNaN(lastMs) && now - lastMs < RECENT_MS) {
      state = "done";
      bubble = "hotovo!";
    } else if (crons.length) {
      state = "sleep";
    } else if (requests > 0) {
      state = "ok";
      chip = "běží";
    } else {
      state = "sleep";
      chip = "ticho";
    }

    const when: string[] = [];
    if (!Number.isNaN(lastMs)) when.push(`naposledy ${ago(lastMs, now)}`);
    if (next) when.push(`příště ${ahead(next, now)}`);
    if (!crons.length) when.push(`${requests} požadavků za 24 h`);

    const every = crons.map((c) => cronEvery(c) ?? `${c} (UTC)`).join(", ");
    return {
      id: `cf:${w.name}`,
      group: "cloudflare",
      name: w.name,
      doing,
      when: when.join(" · "),
      state,
      chip,
      bubble,
      character: characterFor(`cf:${w.name}`),
      facts: [
        ["Cron", every || "žádný"],
        ["Za 24 h", `${requests} běhů, ${errors} chyb`],
        ["Nasazeno", ago(Date.parse(w.modifiedOn), now)],
      ],
      log: {
        lines: events
          .filter((e) => e.scriptName === w.name)
          .slice(0, 12)
          .map((e) => `${new Date(e.datetime).toLocaleString("cs-CZ")}  ${e.status.padEnd(9)} ${e.cron}`)
          .concat(events.some((e) => e.scriptName === w.name) ? [] : ["Žádné běhy cronu za posledních 24 h."]),
      },
      actions: [
        {
          label: "Otevřít v Cloudflare",
          primary: true,
          command: { type: "open", target: `https://dash.cloudflare.com/${snap.account}/workers/services/view/${w.name}/production` },
        },
      ],
    };
  });
  return {
    id: "cloudflare",
    title: "Cloudflare",
    note: "Workers",
    items,
    notice: problems.length ? `Část dat chybí: ${problems.join(" · ")}` : undefined,
  };
}

// ---------- GitHub ----------

type Workflow = {
  id: number;
  name: string;
  path: string;
  state: string;
  htmlUrl: string;
  lastRun: null | {
    status: string;
    conclusion: string | null;
    event: string;
    branch: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    htmlUrl: string;
  };
};
export type GithubSnapshot =
  | { ok: false; error: string }
  | { ok: true; repos: ({ repo: string; workflows: Workflow[] } | { repo: string; error: string })[] };

const FAILED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

export function githubGroup(snap: GithubSnapshot, now = Date.now()): Group | null {
  if (!snap.ok) return { id: "github", title: "GitHub", note: "Actions", items: [], notice: snap.error };
  if (!snap.repos.length) return null;
  const errors: string[] = [];
  const items: Item[] = [];
  for (const r of snap.repos) {
    if ("error" in r) {
      errors.push(`${r.repo}: ${r.error}`);
      continue;
    }
    const short = r.repo.split("/")[1];
    for (const w of r.workflows) {
      const run = w.lastRun;
      const updated = run ? Date.parse(run.updatedAt) : NaN;
      let state: State;
      let chip: string | undefined;
      let bubble: string | undefined;
      let doing = run ? `${short}: ${run.title}` : `${short}: zatím neběžel`;
      if (w.state !== "active") {
        state = "off";
        doing = `${short}: vypnutý`;
      } else if (run && run.status !== "completed") {
        state = "run";
      } else if (run && run.conclusion && FAILED.has(run.conclusion)) {
        state = "bad";
        bubble = "červená";
      } else if (run?.conclusion === "success" && now - updated < RECENT_MS) {
        state = "done";
        bubble = "hotovo!";
      } else if (run?.conclusion === "success") {
        state = "ok";
        chip = "zelená";
      } else {
        state = "sleep";
      }
      const file = w.path.split("/").pop() ?? "";
      const actions: ActionSpec[] = [];
      if (w.state === "active") {
        if (state !== "run") {
          actions.push({
            label: "Spustit teď",
            primary: true,
            confirm: "Spustí workflow na GitHubu. Pokračovat?",
            command: { type: "github", repo: r.repo, workflowId: w.id, action: "run" },
          });
        }
        actions.push({ label: "Vypnout", confirm: "Opravdu vypnout?", command: { type: "github", repo: r.repo, workflowId: w.id, action: "disable" } });
      } else {
        actions.push({
          label: "Zapnout",
          primary: true,
          confirm: "Zapnout? Běhy spotřebují minuty Actions.",
          command: { type: "github", repo: r.repo, workflowId: w.id, action: "enable" },
        });
      }
      actions.push({ label: "Otevřít na GitHubu", command: { type: "open", target: `https://github.com/${r.repo}/actions/workflows/${file}` } });

      items.push({
        id: `gh:${r.repo}/${w.id}`,
        group: "github",
        name: w.name,
        doing,
        when: run ? `naposledy ${ago(updated, now)} · ${run.event}` : "zatím neběžel",
        state,
        chip,
        bubble,
        character: characterFor(`gh:${r.repo}/${w.name}`),
        facts: [
          ["Repo", r.repo],
          ["Soubor", w.path],
          ["Poslední běh", run ? `${run.conclusion ?? run.status} (${run.branch})` : "–"],
        ],
        log: { lines: run ? [`${run.title}`, `${run.event} · ${run.branch} · ${run.conclusion ?? run.status}`, run.htmlUrl] : ["Zatím žádný běh."] },
        actions,
      });
    }
  }
  return { id: "github", title: "GitHub", note: "Actions", items, notice: errors.length ? errors.join(" · ") : undefined };
}
