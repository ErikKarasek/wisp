import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { openAgentForm } from "./agentform";
import { EV_NOTCH_PREFS, EV_OPEN, EV_OPEN_SETTINGS, EV_REFRESH, EV_REQUEST, EV_STATE, type ClaudeUsage, type MiniItem, type QuotaWindow, type AgyWindow, type Snapshot, windowName, resetText } from "./broadcast";
import { renderReviews } from "./reviews";
import { focusAgent, renderChat } from "./chat";
import { startPhone } from "./phone";
import { startRelay } from "./relay";

/** Sidebar entries that replace the cards with a view of their own. */
const VIEWS = ["settings", "tasks", "reviews", "chat"];
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { fullCharacter, loadConfig, NOTCH_WIDTH, saveConfig, type Config } from "./config";
import { EXPRESSIONS, type MascotCharacter } from "./mascot/mascot";
import { mascotSvg, mountMascot, type MountedMascot } from "./mascot/svg";
import {
  cloudflareGroup,
  cloudflareNeurons,
  githubGroup,
  macGroup,
  NEURONS_PER_DAY,
  paperclipGroups,
  SEVERITY,
  STATES,
  type ActionSpec,
  type CloudflareSnapshot,
  type GithubSnapshot,
  type Group,
  type Item,
  type Job,
  type PaperclipSnapshot,
  type State,
} from "./model";
import { openJobForm } from "./jobform";
import { latestRun, LiveRun, stepLine, type Step } from "./live";
import { openRoutineForm } from "./routineform";
import { renderTasks } from "./tasks";
import { renderSettings } from "./settings";
import { sounds } from "./sounds";
import { openStudio } from "./studio";
import { ago } from "./time";

const LOCAL_MS = 10_000; // launchd and Paperclip, both on this Mac
const CLOUD_MS = 60_000; // Cloudflare and GitHub, rate limits apply

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let cfg: Config;
let localGroups: Group[] = [];
let cloudGroups: Group[] = [];
let cloudflare: CloudflareSnapshot | null = null;
let groups: Group[] = [];
/** The name and face each item has before the user's own settings. */
const automatic = new Map<string, { name: string; character: Partial<MascotCharacter> }>();
let filter = "all";
let selected: string | null = null;
let jobs: Job[] = [];
let paperclip: PaperclipSnapshot | null = null;
let usage: ClaudeUsage | null = null;
let gptQuota: QuotaWindow[] = [];
let geminiQuota: AgyWindow[] = [];
/** Antigravity takes ~10 s to answer, so Gemini is read less often. */
const GEMINI_MS = 2 * 60_000;
/** How often both limits are read: often enough to watch them move while agents work. */
const USAGE_MS = 60_000;

/** The limits next to the menu-bar icon, e.g. "C 59 %  G 14 %". */
function trayTitle(): string {
  if (!cfg.trayLimits) return "";
  const parts: string[] = [];
  if (usage?.session) parts.push(`C ${usage.session.percent} %`);
  if (gptQuota[0]) parts.push(`G ${gptQuota[0].percent} %`);
  const gem = geminiQuota.find((w) => w.group === "Gemini" && w.windowSecs === 5 * 3600);
  if (gem) parts.push(`Ge ${gem.percent} %`);
  return parts.join("  ");
}
let prCount = 0;
/** The open pull requests, as the phone shows them under "Ke kontrole". */
let prList: Record<string, any>[] = [];
/** The last item that changed in a way worth showing in the notch. */
let news: MiniItem | null = null;

type HistoryEntry = { id: string; name: string; state: State; at: number; text: string };
let history: HistoryEntry[] = [];

// ---------- data ----------

async function loadLocal() {
  const now = Date.now();
  const [jobList, snap] = await Promise.all([
    invoke<Job[]>("list_jobs").catch(() => [] as Job[]),
    invoke<PaperclipSnapshot>("paperclip_snapshot").catch((e) => ({ online: false, error: String(e) }) as PaperclipSnapshot),
  ]);
  jobs = jobList;
  paperclip = snap;
  void watchPaperclip(snap.online);
  localGroups = [macGroup(jobs, now), ...paperclipGroups(snap, now)];
}

// ---------- Claude Code sessions (from its hooks), for the phone ----------

/** What each Claude Code session is doing, like the notch keeps it. */
const ccSessions = new Map<string, { project: string; lines: string[]; busy: boolean; at: number }>();
void listen<{ session: string; project: string; kind: string; text: string }>("cc-event", (e) => {
  const { session, project, kind, text } = e.payload;
  if (kind === "end") return void ccSessions.delete(session);
  const cur = ccSessions.get(session) ?? { project, lines: [], busy: false, at: Date.now() };
  cur.project = project;
  cur.at = Date.now();
  if (kind === "prompt") {
    cur.busy = true;
    cur.lines = text ? [`› ${text}`] : [];
  } else if (kind === "step") {
    cur.busy = true;
    cur.lines = [...cur.lines, text].slice(-6);
  } else if (kind === "done" || kind === "waiting") {
    cur.busy = false;
  }
  ccSessions.set(session, cur);
  updateGlow();
});
/** The screen glow follows whether anything works; it fades out a few seconds after the last step. */
let glowOn = false;
let glowOffTimer = 0;
function updateGlow() {
  const want = cfg.notchPrefs.glow !== false && (liveNow.length > 0 || ccLive().length > 0);
  if (want) {
    clearTimeout(glowOffTimer);
    glowOffTimer = 0;
    if (!glowOn) {
      glowOn = true;
      void invoke("glow_set", { on: true });
    }
  } else if (glowOn && !glowOffTimer) {
    glowOffTimer = window.setTimeout(() => {
      glowOn = false;
      glowOffTimer = 0;
      void invoke("glow_set", { on: false });
    }, 4000);
  }
}
setInterval(updateGlow, 5000);

/** Claude Code sessions working right now, as "live" entries. */
function ccLive() {
  const now = Date.now();
  return [...ccSessions.values()]
    .filter((s) => s.busy && now - s.at < 120_000)
    .sort((a, b) => b.at - a.at)
    // A Paperclip agent's Claude reports "agent:<id>": show the agent's name.
    .map((s) => ({ name: s.project.startsWith("agent:") ? allItems().find((i) => i.id === s.project)?.name ?? "Agent" : `${s.project} · Claude`, lines: s.lines.slice(-3) }));
}

// ---------- Focus (a Shortcuts automation tells us) and messages from local scripts ----------

let focus = false;
/** What came in while Erik was focused; it waits until the Focus ends. */
let held: string[] = [];
void listen<boolean>("focus", (e) => {
  focus = e.payload;
  broadcast();
  if (!focus && held.length) {
    const text = `Během soustředění:\n${held.map((h) => `• ${h}`).join("\n")}`;
    held = [];
    toast(text.replace(/\n/g, " "));
    if (cfg.telegram.enabled && cfg.telegram.chat) void invoke("telegram_send", { chat: cfg.telegram.chat, text }).catch(() => {});
  }
});
void listen<{ title?: string; text?: string; urgent?: boolean }>("notify", async (e) => {
  const title = e.payload.title ?? "Wisp";
  const text = (e.payload.text ?? "").slice(0, 3500);
  if (focus && !e.payload.urgent) return void held.push(`${title}: ${text.split("\n")[0]}`);
  toast(`${title}: ${text.split("\n")[0]}`);
  if (cfg.notifications && (await isPermissionGranted().catch(() => false))) sendNotification({ title, body: text.split("\n").slice(0, 3).join(" ") });
  if (cfg.telegram.enabled && cfg.telegram.chat) void invoke("telegram_send", { chat: cfg.telegram.chat, text: `${title}\n\n${text}` }).catch(() => {});
});

// ---------- Claude's limit: agents pause before it runs out, and come back after ----------

/** Agents the guard paused itself, so it only ever wakes those, never one Erik paused. */
const GUARD_KEY = "wisp.guard.paused";
const guardPaused = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(GUARD_KEY) ?? "[]");
  } catch {
    return [];
  }
};
let guarding = false;
async function guardClaude(u: ClaudeUsage | null) {
  if (!u || !paperclip?.online || guarding) return;
  guarding = true;
  try {
    const session = u.session?.percent ?? 0;
    const week = u.week?.percent ?? 0;
    const agents = paperclip.companies.flatMap((c) => c.agents).filter((a) => a.adapterType === "claude_local" && a.status !== "terminated");
    let paused = guardPaused();
    if (session >= 90 || week >= 95) {
      const now = agents.filter((a) => a.status !== "paused" && !paused.includes(a.id));
      for (const a of now) {
        await invoke("paperclip_action", { kind: "agentPause", id: a.id }).catch(() => {});
        paused.push(a.id);
      }
      if (now.length) warn(`Limit Claude je na ${Math.max(session, week)} %: pozastavil jsem ${now.map((a) => a.name).join(", ")}, ať ho nedočerpají. Až se limit obnoví, sami se rozjedou.`);
    } else if (session < 60 && week < 90 && paused.length) {
      const back = agents.filter((a) => paused.includes(a.id));
      for (const a of back) {
        await invoke("paperclip_action", { kind: "agentResume", id: a.id }).catch(() => {});
        // Woken right away, so the tasks it left half done get finished.
        await invoke("paperclip_action", { kind: "agentInvoke", id: a.id }).catch(() => {});
      }
      if (back.length) warn(`Limit Claude se obnovil: ${back.map((a) => a.name).join(", ")} zase pracuje a dodělá rozdělané úkoly.`);
      paused = [];
    }
    localStorage.setItem(GUARD_KEY, JSON.stringify(paused));
  } finally {
    guarding = false;
  }
}

// ---------- every morning: what Fixer did overnight ----------

const DIGEST_KEY = "wisp.fixerDigest";
async function fixerDigest() {
  const today = new Date().toDateString();
  if (new Date().getHours() < 8 || localStorage.getItem(DIGEST_KEY) === today) return;
  if (!cfg.telegram.enabled || !cfg.telegram.chat || !paperclip?.online) return;
  type Obj = Record<string, any>;
  const list = (v: Obj[] | { items: Obj[] }) => (Array.isArray(v) ? v : v.items ?? []);
  const since = Date.now() - 24 * 3600_000;
  const done: string[] = [];
  const stuck: string[] = [];
  let working = 0;
  for (const c of paperclip.companies) {
    const issues = list(await invoke<Obj[] | { items: Obj[] }>("paperclip_request", { method: "GET", path: `/companies/${c.company.id}/issues`, body: null }).catch(() => []));
    for (const i of issues.filter((x) => String(x.title).startsWith("[review]") && Date.parse(x.updatedAt) > since)) {
      const title = String(i.title).replace(/^\[review\]\s*/, "");
      if (i.status === "done" || i.status === "in_review") {
        const comments = list(await invoke<Obj[] | { items: Obj[] }>("paperclip_request", { method: "GET", path: `/issues/${i.id}/comments`, body: null }).catch(() => []));
        const pr = comments.map((m) => String(m.body ?? "")).join("\n").match(/https:\/\/github\.com\/[^\s)]+\/pull\/\d+/g)?.at(-1);
        done.push(`✅ ${title}${pr ? `\n   ${pr}` : ""}`);
      } else if (i.status === "blocked") {
        const comments = list(await invoke<Obj[] | { items: Obj[] }>("paperclip_request", { method: "GET", path: `/issues/${i.id}/comments`, body: null }).catch(() => []));
        const why = String([...comments].reverse().find((m) => m.authorAgentId)?.body ?? "").replace(/[*`#>]/g, "").split("\n").find((l) => l.trim()) ?? "";
        stuck.push(`⚠️ ${title}${why ? `\n   ${why.trim().slice(0, 160)}` : ""}`);
      } else if (i.status === "in_progress" || i.status === "todo") working++;
    }
  }
  localStorage.setItem(DIGEST_KEY, today);
  if (!done.length && !stuck.length && !working && !prList.length) return;
  const lines = ["🛠 Fixer za posledních 24 h"];
  if (done.length) lines.push("", `Opraveno (${done.length}):`, ...done);
  if (stuck.length) lines.push("", `Zaseklo se, potřebuje tě (${stuck.length}):`, ...stuck);
  if (working) lines.push("", `Ještě na tom pracuje: ${working}`);
  if (prList.length) lines.push("", `Čeká na tvoje mergnutí: ${prList.length} PR (Wisp → Ke kontrole)`, ...prList.slice(0, 6).map((p) => `• ${String(p.repo).split("/").pop()}#${p.number} ${p.title}`));
  void invoke("telegram_send", { chat: cfg.telegram.chat, text: lines.join("\n") }).catch(() => {});
}
setInterval(() => void fixerDigest(), 10 * 60_000);
setTimeout(() => void fixerDigest(), 60_000);

// ---------- safety nets ----------

/** Tell Erik on the screen and, when Telegram is on, on the phone. */
function warn(text: string) {
  toast(text);
  if (cfg.telegram.enabled && cfg.telegram.chat) void invoke("telegram_send", { chat: cfg.telegram.chat, text: `Wisp: ${text}` }).catch(() => {});
}

// Paperclip runs the agents; when it stops answering twice in a row, launchd restarts it (at most every 10 min).
const PAPERCLIP_JOB = "ing.paperclip.paperclipai";
let paperclipDown = 0;
let paperclipKicked = 0;
async function watchPaperclip(online: boolean) {
  if (online) {
    if (paperclipKicked && paperclipDown) warn("Paperclip zase běží, agenti můžou pracovat.");
    paperclipDown = 0;
    return;
  }
  paperclipDown++;
  if (paperclipDown < 2 || Date.now() - paperclipKicked < 10 * 60_000) return;
  if (!jobs.some((j) => j.label === PAPERCLIP_JOB)) return;
  paperclipKicked = Date.now();
  const ok = await invoke("job_action", { label: PAPERCLIP_JOB, action: "restart" }).then(() => true).catch(() => false);
  warn(ok ? "Paperclip neodpovídal, restartoval jsem ho." : "Paperclip neodpovídá a restart se nepovedl. Mrkni na něj.");
}

// ChatGPT agents need Codex by its full path, which a Paperclip update moves.
async function healCodex() {
  const fixed = await invoke<string[]>("heal_codex").catch(() => [] as string[]);
  if (fixed.length) warn(`Po aktualizaci Paperclipu jsem opravil cestu ke Codexu: ${fixed.join(", ")}.`);
}

async function loadCloud() {
  const now = Date.now();
  const [cf, gh] = await Promise.all([
    invoke<CloudflareSnapshot>("cloudflare_snapshot").catch((e) => ({ configured: true, error: String(e) }) as CloudflareSnapshot),
    cfg.githubRepos?.length
      ? invoke<GithubSnapshot>("github_snapshot", { repos: cfg.githubRepos }).catch((e) => ({ ok: false, error: String(e) }) as GithubSnapshot)
      : Promise.resolve(null),
  ]);
  cloudflare = cf;
  cloudGroups = [cloudflareGroup(cf, now), gh && githubGroup(gh, now)].filter((g): g is Group => !!g);
  if (cfg.githubRepos?.length) {
    prList = await invoke<Record<string, any>[]>("github_prs", { repos: cfg.githubRepos }).catch(() => []);
    prCount = prList.length;
  }
}

/** Apply the user's names and characters on top of what the sources report. */
function compose() {
  // Work on copies, so applying the settings twice never mixes them into the originals.
  groups = [...localGroups, ...cloudGroups].map((g) => ({ ...g, items: g.items.map((i) => ({ ...i })) }));
  for (const item of groups.flatMap((g) => g.items)) {
    automatic.set(item.id, { name: item.name, character: item.character });
    const charId = cfg.assignments[item.id];
    const saved = charId ? cfg.characters.find((c) => c.id === charId) : undefined;
    if (saved) item.character = saved.character;
    if (cfg.names[item.id]) item.name = cfg.names[item.id];
    const note = cfg.notes[item.id];
    if (note && item.about !== undefined) {
      // The user's words replace the built-in description, not a live error or task.
      if (item.doing === item.about) item.doing = note;
      item.about = note;
    } else if (note) {
      item.facts = [["Poznámka", note], ...item.facts];
    }
  }
}

const allItems = () => groups.flatMap((g) => g.items);

async function save() {
  await saveConfig(cfg);
  compose();
  render();
}

// ---------- cards ----------

type Card = { el: HTMLElement; mascot: MountedMascot; state: State; look: string };
const cards = new Map<string, Card>();
const groupEls = new Map<string, HTMLElement>();

function cardFor(item: Item, seed: number): Card {
  const look = JSON.stringify(item.character);
  let card = cards.get(item.id);
  if (!card) {
    const el = document.createElement("div");
    el.className = "card";
    el.dataset.id = item.id;
    el.innerHTML = `<div class="bubble"></div><div class="m"></div>
      <div class="name"><span class="t"></span><span class="chip"></span></div>
      <div class="doing"></div><div class="when"></div>`;
    el.addEventListener("click", () => select(item.id));
    el.querySelector(".m")!.addEventListener("click", () => poke(item.id));
    const mascot = mountMascot(el.querySelector(".m") as HTMLElement, {
      character: item.character,
      expression: STATES[item.state].expr,
      seed,
    });
    card = { el, mascot, state: item.state, look };
    cards.set(item.id, card);
  }
  const s = STATES[item.state];
  if (card.state !== item.state) {
    card.mascot.setExpression(s.expr);
    card.state = item.state;
  }
  if (card.look !== look) {
    card.mascot.setCharacter(fullCharacter(item.character));
    card.look = look;
  }
  const q = (sel: string) => card!.el.querySelector(sel) as HTMLElement;
  q(".t").textContent = item.name;
  q(".chip").textContent = item.chip ?? s.chip;
  q(".chip").className = `chip s-${item.state}`;
  q(".doing").textContent = item.doing;
  q(".doing").title = item.doing;
  q(".when").textContent = item.when;
  if (item.engine) {
    const tag = document.createElement("b");
    tag.className = `eng ${{ ChatGPT: "gpt", Gemini: "gem", Claude: "cl" }[item.engine]}`;
    tag.textContent = item.engineLabel ?? item.engine;
    q(".when").prepend(tag);
  }
  // A poked character keeps its reaction until it calms down.
  if (!poking(item.id)) q(".bubble").textContent = item.bubble ?? "";
  card.el.classList.toggle("sel", item.id === selected);
  return card;
}

// Poke a character: it jumps and looks surprised. Too many pokes make it cross.
const pokes = new Map<string, number[]>();
const poking = (id: string) => Date.now() - (pokes.get(id)?.at(-1) ?? 0) < 1200;
function poke(id: string) {
  const card = cards.get(id);
  if (!card) return;
  const now = Date.now();
  const recent = (pokes.get(id) ?? []).filter((t) => now - t < 2500).concat(now);
  pokes.set(id, recent);
  const cross = recent.length >= 5;
  const m = card.el.querySelector(".m") as HTMLElement;
  m.classList.remove("hop");
  void m.offsetWidth; // restart the animation
  m.classList.add("hop");
  card.mascot.setExpression(cross ? "angry" : recent.length >= 3 ? "happy" : "surprised");
  const bubble = card.el.querySelector(".bubble") as HTMLElement;
  if (cross) bubble.textContent = "nech mě!";
  if (cfg.sounds) sounds.poke(cross ? 0.6 : 1 + recent.length * 0.08);
  window.setTimeout(() => {
    if (Date.now() - (pokes.get(id)?.at(-1) ?? 0) < 1100) return;
    card.mascot.setExpression(STATES[card.state].expr);
    const item = allItems().find((i) => i.id === id);
    bubble.textContent = item?.bubble ?? "";
    if (cross) pokes.set(id, []);
  }, 1200);
}

function matches(item: Item) {
  switch (filter) {
    case "all":
      return true;
    case "attention":
      return ["bad", "you", "new"].includes(item.state);
    case "run":
      return item.state === "run";
    case "sleep":
      return item.state === "sleep";
    case "engine:ChatGPT":
    case "engine:Gemini":
    case "engine:Claude":
      return item.engine === filter.slice(7);
    default:
      return item.group === filter;
  }
}

function renderMain() {
  const main = $("main");
  const settings = $("settings");
  const tasks = $("tasks");
  const reviews = $("reviews");
  const chat = $("chat");
  chat.hidden = filter !== "chat";
  if (VIEWS.includes(filter)) {
    groupEls.forEach((s) => (s.hidden = true));
    settings.hidden = filter !== "settings";
    tasks.hidden = filter !== "tasks";
    reviews.hidden = filter !== "reviews";
    return;
  }
  settings.hidden = true;
  tasks.hidden = true;
  reviews.hidden = true;
  const seen = new Set<string>();
  groups.forEach((g, gi) => {
    let sec = groupEls.get(g.id);
    if (!sec) {
      sec = document.createElement("section");
      sec.className = "group";
      sec.innerHTML = `<h3></h3><div class="cards"></div>`;
      groupEls.set(g.id, sec);
    }
    main.appendChild(sec); // keeps group order; moving keeps the mascots alive
    sec.querySelector("h3")!.innerHTML =
      `${esc(g.title)} <em>${esc(g.note)}</em>` +
      (g.id === "mac"
        ? `<button class="add-job" data-act="newJob">+ Nová úloha</button>`
        : g.company
          ? `<span class="h-actions"><button class="add-job" data-act="newRoutine" data-company="${esc(g.company.id)}">+ Nová rutina</button>` +
            `<button class="add-job" data-act="newAgent" data-company="${esc(g.company.id)}">+ Nový agent</button></span>`
          : "");
    const list = sec.querySelector(".cards") as HTMLElement;
    let notice = sec.querySelector(".notice") as HTMLElement | null;
    if (g.notice && !notice) {
      notice = document.createElement("div");
      notice.className = "notice";
      notice.innerHTML = `<div class="m"></div><span></span>`;
      sec.insertBefore(notice, list);
      mountMascot(notice.querySelector(".m") as HTMLElement, { character: { color: "#8a909b" }, expression: "sad" });
    }
    if (notice) {
      notice.hidden = !g.notice;
      notice.querySelector("span")!.textContent = g.notice ?? "";
    }
    let visible = 0;
    g.items.forEach((item, i) => {
      const card = cardFor(item, gi * 31 + i * 7);
      list.appendChild(card.el);
      card.el.hidden = !matches(item);
      if (!card.el.hidden) visible++;
      seen.add(item.id);
    });
    sec.hidden = visible === 0 && !(g.notice && (filter === "all" || filter === g.id));
  });
  for (const [id, card] of cards) {
    if (!seen.has(id)) {
      card.mascot.destroy();
      card.el.remove();
      cards.delete(id);
    }
  }
  for (const [id, sec] of groupEls) {
    if (!groups.some((g) => g.id === id)) {
      sec.remove();
      groupEls.delete(id);
    }
  }
}

// ---------- header, sidebar ----------

function renderSummary() {
  const items = allItems();
  const count = (states: State[]) => items.filter((i) => states.includes(i.state)).length;
  const parts: [string, number, string][] = [
    ["var(--ok)", count(["ok", "done", "sleep"]), "v pořádku"],
    ["var(--accent)", count(["run"]), "pracuje"],
    ["var(--warn)", count(["you", "new"]), "čeká na tebe"],
    ["var(--bad)", count(["bad"]), "selhalo"],
    ["#8a909b", count(["off"]), "vypnuto"],
  ];
  $("summary").innerHTML = parts
    .filter(([, n], i) => n > 0 || i === 0)
    .map(([color, n, label]) => `<div><span class="dot" style="background:${color}"></span><b>${n}</b> ${label}</div>`)
    .join("");
}

function groupLabel(g: Group) {
  return g.id === "mac" ? "Mac" : g.id === "cloudflare" ? "Cloudflare" : g.id === "github" ? "GitHub" : g.note;
}

let legendEl: HTMLElement | null = null;
function renderSide() {
  const items = allItems();
  const n = (f: (i: Item) => boolean) => items.filter(f).length;
  const rows: [string, string, number | null][] = [
    ["all", "Všichni", items.length],
    ["attention", "Potřebují tě", n((i) => ["bad", "you", "new"].includes(i.state))],
    ["run", "Pracují", n((i) => i.state === "run")],
    ["sleep", "Spí", n((i) => i.state === "sleep")],
  ];
  const where: [string, string, number | null][] = groups.map((g) => [g.id, groupLabel(g), g.items.length]);
  // Agents and their routines, by the subscription they run on.
  for (const engine of ["ChatGPT", "Gemini", "Claude"] as const) {
    const count = n((i) => i.engine === engine);
    if (count) where.push([`engine:${engine}`, engine, count]);
  }
  const btn = ([id, label, count]: [string, string, number | null]) =>
    `<button data-f="${esc(id)}" class="${filter === id ? "on" : ""}">${esc(label)}${count == null ? "" : `<span>${count}</span>`}</button>`;

  const claude =
    usage?.session || usage?.week
      ? `<h6>Limit Claude</h6>` +
        [["relace", usage.session], ["týden", usage.week]]
          .filter(([, w]) => w)
          .map(([label, w]) => {
            const win = w as { percent: number; resets: string };
            return `<div class="gauge${win.percent >= 85 ? " hot" : ""}" title="obnoví se ${esc(win.resets)}"><div class="bar"><i style="width:${win.percent}%"></i></div>
              <small>${label}: ${win.percent} %</small></div>`;
          })
          .join("")
      : "";
  const gpt = gptQuota.length
    ? `<h6>Limit ChatGPT</h6>` +
      gptQuota
        .map((w) => {
          const resets = resetText(w.resetsAtMs);
          return `<div class="gauge${w.percent >= 85 ? " hot" : ""}"${resets ? ` title="obnoví se ${esc(resets)}"` : ""}><div class="bar"><i style="width:${w.percent}%"></i></div>
            <small>${esc(windowName(w.windowSecs))}: ${w.percent} %</small></div>`;
        })
        .join("")
    : "";
  const gemRows = geminiQuota.filter((w) => w.group === "Gemini").sort((a, b) => a.windowSecs - b.windowSecs);
  const proRows = geminiQuota.filter((w) => w.group !== "Gemini").sort((a, b) => a.windowSecs - b.windowSecs);
  const gauges = (rows: AgyWindow[]) =>
    rows
      .map((w) => {
        const resets = resetText(w.resetsAtMs);
        return `<div class="gauge${w.percent >= 85 ? " hot" : ""}"${resets ? ` title="obnoví se ${esc(resets)}"` : ""}><div class="bar"><i style="width:${w.percent}%"></i></div>
          <small>${esc(windowName(w.windowSecs))}: ${w.percent} %</small></div>`;
      })
      .join("");
  const gemini =
    (gemRows.length ? `<h6 title="Google AI Pro v Antigravity">Limit Gemini</h6>${gauges(gemRows)}` : "") +
    (proRows.length ? `<h6 title="Claude a GPT modely v Antigravity, zvlášť od tvého předplatného Claude">Claude v AI Pro</h6>${gauges(proRows)}` : "");
  const neurons = cloudflare ? cloudflareNeurons(cloudflare) : null;
  const gauge =
    claude +
    gpt +
    gemini +
    (neurons == null
      ? ""
      : `<h6>Workers AI dnes</h6><div class="gauge${neurons >= NEURONS_PER_DAY * 0.9 ? " hot" : ""}"><div class="bar"><i style="width:${Math.min(100, (neurons / NEURONS_PER_DAY) * 100).toFixed(1)}%"></i></div>
         <small>${Math.round(neurons).toLocaleString("cs-CZ")} z ${NEURONS_PER_DAY.toLocaleString("cs-CZ")} neuronů</small></div>`);

  const side = $("side");
  side.innerHTML =
    rows.map(btn).join("") +
    btn(["chat", "Chat s agenty", null]).replace("<button ", '<button class="chat-btn" ') +
    `<h6>Kde běží</h6>` +
    where.map(btn).join("") +
    gauge +
    `<h6>Tvoje</h6>` +
    btn(["tasks", "Úkoly", paperclip?.online ? paperclip.companies.reduce((n, c) => n + c.issues.length, 0) : null]) +
    btn(["reviews", "Ke kontrole", prCount]) +
    `<button data-act="studio">Postavičky<span>${cfg.characters.length}</span></button>` +
    `<button data-act="newJob">Nová úloha</button>` +
    btn(["settings", "Nastavení", null]);
  side.querySelectorAll<HTMLButtonElement>("button[data-f]").forEach((b) =>
    b.addEventListener("click", () => {
      filter = b.dataset.f!;
      if (VIEWS.includes(filter)) selected = null;
      $("main").scrollTop = 0;
      render();
    }),
  );
  side.querySelector('[data-act="studio"]')!.addEventListener("click", () => studio());

  if (!legendEl) {
    legendEl = document.createElement("div");
    legendEl.innerHTML = `<h6>Co znamená výraz</h6><div class="legend"></div>`;
    const list = legendEl.querySelector(".legend")!;
    (["run", "ok", "done", "sleep", "you", "bad", "off"] as State[]).forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "lg";
      row.innerHTML = `<div class="m"></div>${STATES[s].label}`;
      list.appendChild(row);
      mountMascot(row.querySelector(".m") as HTMLElement, { character: { color: "#8b9cff" }, expression: STATES[s].expr, seed: 70 + i });
    });
  }
  side.appendChild(legendEl);
}

// ---------- studio ----------

function wornBy(characterId: string) {
  return allItems()
    .filter((i) => cfg.assignments[i.id] === characterId)
    .map((i) => i.name);
}

function studio(item?: Item) {
  const auto = item ? automatic.get(item.id) : undefined;
  openStudio({
    cfg,
    item,
    automatic: auto?.character,
    defaultName: auto?.name,
    wornBy,
    save,
  });
}

// ---------- detail ----------

let detailMascot: MountedMascot | null = null;
let detailFor: string | null = null;
let detailLook = "";

function select(id: string | null) {
  selected = id;
  render();
}

async function renderDetail() {
  const detail = $("detail");
  const item = filter === "settings" ? undefined : allItems().find((i) => i.id === selected);
  if (!item) {
    detail.hidden = true;
    detailMascot?.destroy();
    detailMascot = null;
    detailFor = null;
    return;
  }
  detail.hidden = false;
  const look = JSON.stringify(item.character);
  if (detailFor !== item.id) {
    detailMascot?.destroy();
    detail.innerHTML = `<button class="m" title="Změnit postavičku"></button><div class="info">
      <h4><span class="n"></span><span class="chip"></span><button class="icon-btn close" title="Zavřít (Esc)">✕</button></h4>
      <p class="d"></p><div class="facts"></div><div class="history"></div><pre class="log"></pre><div class="live" hidden></div><div class="btns"></div></div>`;
    detail.querySelector(".close")!.addEventListener("click", () => select(null));
    detail.querySelector(".m")!.addEventListener("click", () => {
      const it = allItems().find((i) => i.id === selected);
      if (it) studio(it);
    });
    detailMascot = mountMascot(detail.querySelector(".m") as HTMLElement, {
      character: item.character,
      expression: STATES[item.state].expr,
      seed: 5,
    });
    detailFor = item.id;
    detailLook = look;
  } else {
    detailMascot?.setExpression(STATES[item.state].expr);
    if (detailLook !== look) {
      detailMascot?.setCharacter(fullCharacter(item.character));
      detailLook = look;
    }
  }
  const q = (sel: string) => detail.querySelector(sel) as HTMLElement;
  q(".n").textContent = item.name;
  q(".chip").textContent = item.chip ?? STATES[item.state].chip;
  q(".chip").className = `chip s-${item.state}`;
  q(".d").textContent = `${item.doing} · ${item.when}`;
  const charId = cfg.assignments[item.id];
  const charName = cfg.characters.find((c) => c.id === charId)?.name;
  q(".facts").innerHTML = [...item.facts, ["Postavička", charName ?? "automatická"] as [string, string]]
    .map(([k, v]) => `<span>${esc(k)}: <b>${esc(v)}</b></span>`)
    .join("");

  const past = history.filter((h) => h.id === item.id).slice(-12).reverse();
  q(".history").innerHTML = past.length
    ? past.map((h) => `<span class="h s-${h.state}" title="${esc(h.text)}"><i></i>${esc(STATES[h.state].chip)} <small>${esc(ago(h.at))}</small></span>`).join("")
    : `<span class="h empty">Zatím žádné změny. Historie se zapisuje, dokud Wisp běží.</span>`;

  const btns = q(".btns");
  const sig = actionSig(item.actions);
  if (btns.dataset.for !== item.id || btns.dataset.sig !== sig) {
    btns.dataset.for = item.id;
    btns.dataset.sig = sig;
    btns.innerHTML = "";
    for (const a of item.actions) btns.appendChild(actionButton(a));
    const dress = document.createElement("button");
    dress.className = "btn";
    dress.textContent = "Postavička…";
    dress.addEventListener("click", () => studio(item));
    btns.appendChild(dress);
  }

  const log = q(".log");
  const liveBox = q(".live");
  liveBox.hidden = !(item.log && "agent" in item.log);
  if (item.log && "agent" in item.log) {
    log.hidden = true;
    await renderLive(liveBox, item.log.agent.companyId, item.log.agent.agentId);
  } else if (!item.log) {
    log.hidden = true;
  } else if ("lines" in item.log) {
    log.hidden = false;
    log.textContent = item.log.lines.join("\n");
  } else {
    log.hidden = false;
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 4;
    try {
      const text = await invoke<string>("job_log", { label: item.log.job, lines: 60 });
      log.innerHTML = text
        ? text
            .split("\n")
            .map((l) => (/error|fail|chyba|exception|denied|401|403/i.test(l) ? `<span class="e">${esc(l)}</span>` : esc(l)))
            .join("\n")
        : "Log je prázdný.";
    } catch (e) {
      log.textContent = String(e);
    }
    if (atBottom) log.scrollTop = log.scrollHeight;
  }
}

// ---------- live runs ----------

const liveRuns = new Map<string, LiveRun>(); // agent id → its latest run's reader
const runStatus = new Map<string, string>(); // run id → status

async function liveFor(companyId: string, agentId: string) {
  const run = await latestRun(companyId, agentId).catch(() => null);
  if (!run) return null;
  let live = liveRuns.get(agentId);
  if (!live || live.runId !== run.id) {
    live = new LiveRun(run.id);
    liveRuns.set(agentId, live);
  }
  // A finished run's log doesn't change; read it once more and then leave it.
  if (runStatus.get(run.id) !== run.status || run.status === "running" || !live.steps.length) {
    await live.poll().catch(() => {});
    runStatus.set(run.id, run.status);
  }
  return { run, steps: live.steps };
}

const STEP_ICON = { running: "…", done: "✓", failed: "✗" };

async function renderLive(box: HTMLElement, companyId: string, agentId: string) {
  const got = await liveFor(companyId, agentId);
  if (!got) {
    box.innerHTML = `<p class="muted">Tenhle agent ještě neběžel.</p>`;
    return;
  }
  const { run, steps } = got;
  const atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
  const head = run.status === "running" ? `<b class="pulse">Právě pracuje</b>` : `Poslední běh ${run.finishedAt ? ago(Date.parse(run.finishedAt)) : ""} · ${run.status === "succeeded" ? "dopadl dobře" : run.status}`;
  box.innerHTML =
    `<div class="lhead">${head}</div>` +
    (steps.length ? steps.slice(-80).map(stepHtml).join("") : `<p class="muted">Zatím nic.</p>`);
  if (atBottom || run.status === "running") box.scrollTop = box.scrollHeight;
}

function stepHtml(s: Step) {
  if (s.kind === "say") return `<div class="lsay">${esc(s.text.trim())}</div>`;
  return `<div class="ltool ${s.status}"><i>${STEP_ICON[s.status]}</i><div><code>${esc(s.title)}</code>${
    s.detail ? `<small>${esc(s.detail)}</small>` : ""
  }${s.output ? `<pre>${esc(s.output.slice(0, 1200))}</pre>` : ""}</div></div>`;
}

type LiveLine = { id: string; name: string; character: Item["character"]; lines: string[] };
let liveNow: LiveLine[] = [];

/** Every couple of seconds while an agent works: its detail and the notch follow along. */
async function liveTick() {
  const working = allItems().filter((i) => i.state === "run" && i.log && "agent" in i.log);
  const next: LiveLine[] = [];
  for (const i of working) {
    const a = (i.log as { agent: { companyId: string; agentId: string } }).agent;
    const got = await liveFor(a.companyId, a.agentId);
    if (!got) continue;
    const lines = got.steps.slice(-4).map(stepLine).filter(Boolean).map((l) => l.slice(0, 90));
    next.push({ id: i.id, name: i.name, character: i.character, lines });
  }
  const changed = JSON.stringify(next) !== JSON.stringify(liveNow);
  liveNow = next;
  if (changed) broadcast();
  const sel = allItems().find((i) => i.id === selected);
  if (sel && sel.state === "run" && sel.log && "agent" in sel.log) {
    const box = document.querySelector<HTMLElement>("#detail .live");
    if (box) await renderLive(box, sel.log.agent.companyId, sel.log.agent.agentId);
  }
}
setInterval(() => void liveTick(), 2500);

const actionSig = (actions: ActionSpec[]) => actions.map((a) => a.label).join("|");

function actionButton(a: ActionSpec): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = `btn${a.primary ? " primary" : ""}`;
  b.textContent = a.label;
  let armed = 0;
  b.addEventListener("click", async () => {
    // Ask on the button itself: the first click arms it for a few seconds.
    if (a.confirm && Date.now() - armed > 4000) {
      armed = Date.now();
      b.textContent = a.confirm;
      setTimeout(() => {
        if (b.isConnected) b.textContent = a.label;
      }, 4000);
      return;
    }
    b.disabled = true;
    try {
      await runCommand(a);
    } finally {
      if (b.isConnected) {
        b.disabled = false;
        b.textContent = a.label;
      }
    }
  });
  return b;
}

async function runCommand(a: ActionSpec) {
  const c = a.command;
  if (c.type === "editJob") return jobForm(jobs.find((j) => j.label === c.label));
  if (c.type === "editAgent") return agentForm(c.companyId, c.agentId);
  if (c.type === "cleanup") {
    await invoke("run_cleanup");
    return toast("Uklízím. Až to bude hotové, dám vědět, kolik se uvolnilo.", true);
  }
  if (c.type === "chatAgent") {
    focusAgent(c.agentId);
    filter = "chat";
    selected = null;
    chatShown = false;
    return render();
  }
  if (c.type === "editRoutine") return routineForm(c.companyId, c.routineId);
  try {
    if (c.type === "open") {
      if (/^https?:/.test(c.target)) await openUrl(c.target);
      else await openPath(c.target);
      return;
    }
    if (c.type === "job") await invoke("job_action", { label: c.label, action: c.action });
    else if (c.type === "paperclip") await invoke("paperclip_action", { kind: c.kind, id: c.id });
    else await invoke("github_action", { repo: c.repo, workflowId: c.workflowId, action: c.action });
    toast(`${a.label}: hotovo`, true);
  } catch (e) {
    toast(String(e));
  }
  // The sources need a moment before the new state shows.
  const cloud = c.type === "github";
  setTimeout(() => void refresh(cloud), 1000);
  setTimeout(() => void refresh(cloud), cloud ? 6000 : 3000);
}

let toastTimer = 0;
function toast(text: string, ok = false) {
  const t = $("toast");
  t.textContent = text;
  t.className = `toast${ok ? " ok" : ""}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ok ? 2500 : 6000);
}

// ---------- changes: history, sounds, notifications, Telegram ----------

const seenStates = new Map<string, State>();
let notifyAllowed: boolean | null = null;

async function onChanges() {
  const now = Date.now();
  const changed: Item[] = [];
  for (const item of allItems()) {
    const before = seenStates.get(item.id);
    seenStates.set(item.id, item.state);
    // The first sighting only sets the baseline.
    if (before !== undefined && before !== item.state) changed.push(item);
  }
  if (!changed.length) return;

  const entries = changed.map((i) => ({ id: i.id, name: i.name, state: i.state, at: now, text: i.doing }));
  history.push(...entries);
  void invoke("history_append", { entries }).catch(() => {});

  let alarming = changed.filter((i) => i.state === "bad" || i.state === "you");
  // The notch peeks out with the most important change.
  const headline = alarming[0] ?? changed.find((i) => i.state === "done") ?? changed.find((i) => i.state === "run" && i.log && "agent" in i.log);
  if (focus) {
    for (const i of alarming.filter((x) => x.state !== "bad")) held.push(`${i.name} na tebe čeká`);
    alarming = alarming.filter((x) => x.state === "bad");
    if (!alarming.length) return;
  }
  if (headline) {
    news = {
      id: headline.id,
      name: headline.name,
      state: headline.state,
      chip: headline.chip ?? STATES[headline.state].chip,
      doing: headline.doing,
      when: headline.when,
      where: "",
      character: headline.character,
    };
    newsAt = Date.now();
    broadcast();
    if (cfg.notch && cfg.notchPrefs.peek) void invoke("notch_peek", { millis: 4500 });
  }
  if (cfg.sounds) {
    if (changed.some((i) => i.state === "bad")) sounds.bad();
    else if (alarming.length) sounds.you();
    else if (changed.some((i) => i.state === "done")) sounds.done();
  }
  if (!alarming.length) return;

  const title = (i: Item) => (i.state === "bad" ? `${i.name}: selhal` : `${i.name} na tebe čeká`);
  if (cfg.notifications) {
    if (notifyAllowed === null) {
      notifyAllowed = (await isPermissionGranted().catch(() => false)) || (await requestPermission().catch(() => "denied")) === "granted";
    }
    if (notifyAllowed) for (const i of alarming.slice(0, 3)) sendNotification({ title: title(i), body: i.doing });
  }
  if (cfg.telegram.enabled && cfg.telegram.chat) {
    const text = ["Wisp", ...alarming.map((i) => `• ${title(i)}\n  ${i.doing}`)].join("\n");
    void invoke("telegram_send", { chat: cfg.telegram.chat, text }).catch((e) => toast(`Telegram: ${e}`));
  }
}

// ---------- job form ----------

function jobForm(job?: Job) {
  openJobForm({
    cfg,
    job,
    save: () => saveConfig(cfg),
    toast,
    created: (id) => {
      filter = "all";
      selected = id;
      void refresh().then(() => {
        const item = allItems().find((i) => i.id === id);
        if (item) studio(item); // straight on to picking its character
      });
    },
    changed: () => void refresh(),
  });
}

document.addEventListener("click", (e) => {
  const el = e.target as HTMLElement;
  if (el.closest('[data-act="newJob"]')) jobForm();
  const hire = el.closest<HTMLElement>('[data-act="newAgent"]');
  if (hire) agentForm(hire.dataset.company!);
  const routine = el.closest<HTMLElement>('[data-act="newRoutine"]');
  if (routine) routineForm(routine.dataset.company!);
});

function routineForm(companyId: string, routineId?: string) {
  if (!paperclip?.online) return toast("Paperclip neodpovídá.");
  const c = paperclip.companies.find((x) => x.company.id === companyId);
  if (!c) return;
  openRoutineForm({
    companyId,
    routine: routineId ? c.routines.find((r) => r.id === routineId) : undefined,
    agents: c.agents,
    toast,
    changed: () => void refresh(),
  });
}

// ---------- agent form ----------

function agentForm(companyId: string, agentId?: string) {
  if (!paperclip?.online) return toast("Paperclip neodpovídá.");
  const c = paperclip.companies.find((x) => x.company.id === companyId);
  if (!c) return;
  void openAgentForm({
    companyId,
    companyName: c.company.name,
    companyPrefix: c.company.issuePrefix ?? "",
    agentId,
    agents: c.agents,
    paperclipUrl: paperclip.baseUrl,
    toast,
    changed: () => void refresh(),
    created: (id) => {
      selected = id;
      void refresh().then(() => {
        const item = allItems().find((i) => i.id === id);
        if (item) studio(item);
      });
    },
  });
}

// ---------- panel and notch ----------

function snapshot(): Snapshot {
  const items = allItems();
  const mini = (i: Item): MiniItem => ({
    id: i.id,
    name: i.name,
    state: i.state,
    chip: i.chip ?? STATES[i.state].chip,
    doing: i.doing,
    when: i.when,
    where: groups.find((g) => g.items.includes(i))?.title ?? "",
    character: i.character,
    ask: i.ask,
  });
  const n = (states: State[]) => items.filter((i) => states.includes(i.state)).length;
  return {
    items: items.map(mini),
    counts: { attention: n(["bad", "you", "new"]), run: n(["run"]), sleep: n(["sleep"]), ok: n(["ok", "done"]), off: n(["off"]) },
    news,
    at: newsAt,
    live: liveNow,
    usage,
    gpt: gptQuota,
    gemini: geminiQuota,
    focus,
    recent: [...new Set(history.slice(-200).reverse().map((h) => h.id))].slice(0, 16),
  };
}
let newsAt = 0;
const broadcast = () => void emit(EV_STATE, snapshot());

void listen(EV_REQUEST, broadcast);
// The bot's updates are taken by another program (job-mail uses its own bot the same way).
let tgConflictShown = false;
void listen("tg-conflict", () => {
  if (tgConflictShown) return;
  tgConflictShown = true;
  toast("Telegram: tvého bota už poslouchá jiný program (asi job-mail). Na ovládání z telefonu dej Wispu vlastního bota.");
});
void listen(EV_REFRESH, () => void refresh(true));
void listen(EV_OPEN_SETTINGS, () => {
  filter = "settings";
  selected = null;
  render();
  void invoke("show_main_window");
});
void listen<{ id: string }>(EV_OPEN, (e) => {
  filter = "all";
  selected = e.payload.id;
  render();
  void invoke("show_main_window");
});

// ---------- tray ----------

let traySig = "";
async function updateTray() {
  const items = allItems();
  const worst = SEVERITY.find((s) => items.some((i) => i.state === s)) ?? "ok";
  const face = worst === "bad" ? "angry" : worst === "you" || worst === "new" ? "curious" : worst === "run" ? "thriving" : "happy";
  const attention = items
    .filter((i) => ["bad", "you", "new", "run"].includes(i.state))
    .sort((a, b) => SEVERITY.indexOf(a.state) - SEVERITY.indexOf(b.state));
  const lines = attention.slice(0, 8).map((i) => `${i.name}: ${i.chip ?? STATES[i.state].chip}`);
  const neurons = cloudflare ? cloudflareNeurons(cloudflare) : null;
  if (neurons != null && neurons >= NEURONS_PER_DAY * 0.9) lines.push(`Workers AI: ${Math.round((neurons / NEURONS_PER_DAY) * 100)} % denního limitu`);
  if (usage?.session && usage.session.percent >= 85) lines.push(`Claude: ${usage.session.percent} % relace, obnoví se ${usage.session.resets}`);
  if (prCount) lines.push(`Ke kontrole: ${prCount} PR`);
  if (!lines.length) lines.push("Všechno v pořádku");
  const tooltip = attention.length ? `Wisp: ${attention.length} potřebuje pozornost` : "Wisp: všechno v pořádku";
  const sig = `${face}|${lines.join("|")}`;
  if (sig === traySig) return;
  traySig = sig;
  try {
    // Like the system icons: a template silhouette that follows the menu bar's
    // colour, with the eyes cut out so the expression still shows. Red when
    // something failed, because that should catch the eye.
    const failed = worst === "bad";
    const svg = failed
      ? mascotSvg({ color: "#e0605a", eyeColor: "#2a0d0b" }, EXPRESSIONS[face], 44)
      : mascotSvg({ color: "#000000", eyeColor: "#ffffff" }, EXPRESSIONS[face], 44);
    const png = await renderPng(svg, 44, !failed);
    await invoke("set_tray", { png: Array.from(png), tooltip, lines, template: !failed });
  } catch {
    // Drawing the tray icon failed; the next refresh tries again.
    traySig = "";
  }
}

async function renderPng(svg: string, size: number, cutOutLight = false): Promise<Uint8Array> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const g = canvas.getContext("2d")!;
  g.drawImage(img, 0, 0, size, size);
  if (cutOutLight) {
    // Light pixels (the eyes) become holes; the dark body stays solid.
    const data = g.getImageData(0, 0, size, size);
    const px = data.data;
    for (let i = 0; i < px.length; i += 4) {
      const light = (px[i] + px[i + 1] + px[i + 2]) / 765;
      px[i + 3] = Math.round(px[i + 3] * (1 - light));
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
    g.putImageData(data, 0, 0);
  }
  const blob = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("png"))), "image/png"));
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------- loop ----------

function render() {
  renderSummary();
  renderSide();
  renderMain();
  void renderDetail();
  if (filter === "settings" && !settingsShown) void showSettings();
  if (filter !== "settings") settingsShown = false;
  if (filter === "tasks" && !tasksShown) showTasks();
  if (filter !== "tasks") tasksShown = false;
  if (filter === "reviews" && !reviewsShown) {
    reviewsShown = true;
    void renderReviews($("reviews"), cfg.githubRepos ?? [], toast, () => void refresh(true));
  }
  if (filter !== "reviews") reviewsShown = false;
  if (filter === "chat" && !chatShown) showChat();
  if (filter !== "chat") chatShown = false;
}

let chatShown = false;
function showChat() {
  chatShown = true;
  if (!paperclip?.online) {
    $("chat").innerHTML = `<p class="muted">Paperclip neodpovídá.</p>`;
    return;
  }
  renderChat($("chat"), {
    companies: paperclip.companies.filter((c) => c.agents.length),
    character: (id) => allItems().find((i) => i.id === `agent:${id}`)?.character ?? {},
    toast,
    changed: () => void refresh(),
  });
}

let settingsShown = false;
let tasksShown = false;
let reviewsShown = false;
function showTasks() {
  tasksShown = true;
  if (!paperclip?.online) {
    $("tasks").innerHTML = `<p class="muted">Paperclip neodpovídá.</p>`;
    return;
  }
  renderTasks($("tasks"), {
    companies: paperclip.companies.filter((c) => c.agents.length),
    toast,
    changed: () => void refresh().then(() => (tasksShown = false)).then(render),
  });
}
async function showSettings() {
  settingsShown = true;
  await renderSettings($("settings"), {
    cfg,
    save: async () => {
      await saveConfig(cfg);
    },
    cloudflare,
    refreshCloud: () => refreshCloud(),
    openStudio: () => studio(),
    setNotch: (on: boolean) => void invoke("notch_set_enabled", { enabled: on }),
    morningNow: () => void morning(true),
    notchChanged: async () => {
      await saveConfig(cfg);
      await invoke("notch_set_width", { width: NOTCH_WIDTH[cfg.notchPrefs.width] });
      await invoke("notch_set_close_delay", { millis: Math.round(cfg.notchPrefs.closeDelay * 1000) });
      await emit(EV_NOTCH_PREFS);
    },
    toast,
  });
}

// The Mac and Paperclip refresh on their own schedule; the cloud (Cloudflare,
// GitHub) separately, so a slow or waiting cloud call never holds the rest up.
let localBusy = false;
let cloudBusy = false;
const spinner = () => $("refresh").classList.toggle("spin", localBusy || cloudBusy);

async function settle() {
  compose();
  render();
  await Promise.all([updateTray(), onChanges()]);
  broadcast();
}

async function refresh(withCloud = false): Promise<void> {
  if (withCloud) void refreshCloud();
  if (localBusy) return;
  localBusy = true;
  spinner();
  try {
    await loadLocal();
    await settle();
  } finally {
    localBusy = false;
    spinner();
  }
}

async function refreshCloud() {
  if (cloudBusy) return;
  cloudBusy = true;
  spinner();
  try {
    await loadCloud();
    await settle();
  } finally {
    cloudBusy = false;
    spinner();
  }
}

// ---------- morning summary ----------

async function morning(force = false) {
  const m = cfg.morning;
  const now = new Date();
  const today = now.toDateString();
  if (!force && (!m.enabled || now.getHours() < m.hour || m.last === today)) return;
  m.last = today;
  await saveConfig(cfg);

  // Since yesterday evening: what finished and what failed.
  const since = new Date(now);
  since.setDate(since.getDate() - 1);
  since.setHours(20, 0, 0, 0);
  const night = history.filter((h) => h.at >= since.getTime());
  const done = new Set(night.filter((h) => h.state === "done").map((h) => h.name));
  const failed = new Set(night.filter((h) => h.state === "bad").map((h) => h.name));
  const waiting = allItems().filter((i) => i.state === "you" || i.state === "bad");
  let events: { title: string; startMs: number; allDay: boolean }[] = [];
  if ((await invoke<string>("calendar_status").catch(() => "none")) === "granted") {
    const start = new Date(today).getTime();
    events = await invoke<typeof events>("calendar_events", { fromMs: start, toMs: start + 86_400_000 }).catch(() => []);
  }
  const hm = (ms: number) => new Date(ms).toLocaleTimeString("cs-CZ", { hour: "numeric", minute: "2-digit" });
  const parts: string[] = [];
  parts.push(done.size ? `Přes noc doběhlo: ${[...done].join(", ")}.` : "Přes noc se nic nedělo.");
  if (failed.size) parts.push(`Selhalo: ${[...failed].join(", ")}.`);
  if (waiting.length) parts.push(`Čeká na tebe: ${waiting.map((i) => i.name).join(", ")}.`);
  parts.push(events.length ? `Dnes: ${events.slice(0, 3).map((e) => `${e.allDay ? "" : hm(e.startMs) + " "}${e.title}`).join(", ")}.` : "V kalendáři dnes nic.");
  // All three subscriptions, and what runs on its own today.
  const limits: string[] = [];
  if (usage?.week) limits.push(`Claude ${usage.week.percent} % týdne`);
  if (gptQuota[0]) limits.push(`ChatGPT ${gptQuota[0].percent} % ${gptQuota[0].windowSecs > 8 * 86400 ? "měsíce" : "limitu"}`);
  const gemWeek = geminiQuota.find((w) => w.group === "Gemini" && w.windowSecs === 7 * 86400);
  const proWeek = geminiQuota.find((w) => w.group !== "Gemini" && w.windowSecs === 7 * 86400);
  if (gemWeek) limits.push(`Gemini ${gemWeek.percent} % týdne`);
  if (proWeek) limits.push(`Claude v AI Pro ${proWeek.percent} % týdne`);
  if (limits.length) parts.push(`Limity: ${limits.join(", ")}.`);
  const certDays = await invoke<number | null>("signing_cert_days").catch(() => null);
  if (certDays != null && certDays <= 30) parts.push(`Certifikát, kterým se podepisuje Wisp, vyprší za ${certDays} dní. Obnov ho v Xcode (Settings → Accounts → Manage Certificates).`);
  const later = allItems()
    .map((i) => {
      const today = /příště dnes (\d{1,2}:\d{2})/.exec(i.when)?.[1];
      const mins = /příště za (\d+) min/.exec(i.when)?.[1];
      return { name: i.name, at: today ?? (mins ? hm(Date.now() + Number(mins) * 60_000) : undefined) };
    })
    .filter((x): x is { name: string; at: string } => !!x.at)
    .sort((a, b) => a.at.localeCompare(b.at, undefined, { numeric: true }));
  if (later.length) parts.push(`Dnes ještě poběží: ${later.slice(0, 5).map((x) => `${x.at} ${x.name}`).join(", ")}.`);
  if (prCount) parts.push(`Ke kontrole ${prCount} PR.`);

  news = {
    id: "morning",
    name: "Dobré ráno",
    state: failed.size || waiting.length ? "you" : "ok",
    chip: failed.size ? `${failed.size} selhalo` : waiting.length ? `${waiting.length} čeká na tebe` : "všechno v pořádku",
    doing: parts.join(" "),
    when: "",
    where: "",
    character: {},
  };
  newsAt = Date.now();
  broadcast();
  if (cfg.notch) void invoke("notch_peek", { millis: 12_000 });
  if (m.telegram && cfg.telegram.enabled && cfg.telegram.chat) {
    void invoke("telegram_send", { chat: cfg.telegram.chat, text: `Dobré ráno\n${parts.join("\n")}` }).catch(() => {});
  }
}

async function start() {
  cfg = await loadConfig();
  history = await invoke<HistoryEntry[]>("history_load").catch(() => []);
  void invoke("notch_set_close_delay", { millis: Math.round(cfg.notchPrefs.closeDelay * 1000) });
  void invoke("notch_set_width", { width: NOTCH_WIDTH[cfg.notchPrefs.width] }).then(() => invoke("notch_set_enabled", { enabled: cfg.notch }));
  // Claude Code in the notch: set its hooks up once; after that the switch in Settings decides.
  if (cfg.ccHooks) {
    // Keep the hooks in step with this version (their timeouts may have changed).
    void invoke("cc_hooks_set", { on: true }).catch(() => {});
  } else if (cfg.ccHooks === undefined) {
    const ok = await invoke("cc_hooks_set", { on: true }).then(() => true).catch(() => false);
    if (ok) {
      cfg.ccHooks = true;
      await saveConfig(cfg);
    }
  }
  // The Mac and Paperclip answer at once; the cloud fills in when it arrives.
  await refresh(false);
  void refresh(true);
  // First run: find the repos with workflows once, in the background.
  if (cfg.githubRepos === null) {
    invoke<string[]>("github_discover")
      .then(async (repos) => {
        cfg.githubRepos = repos;
        await saveConfig(cfg);
        await refresh(true);
      })
      .catch(() => {});
  }
  // ChatGPT answers in a fraction of a second; Claude's CLI takes a few, so both run at once.
  const loadGptQuota = async () => {
    const got = await invoke<{ plan: string; windows: QuotaWindow[] }>("chatgpt_usage").catch(() => null);
    if (got) gptQuota = got.windows;
  };
  const loadUsage = async () => {
    const [claude] = await Promise.all([invoke<ClaudeUsage>("claude_usage").catch(() => usage), loadGptQuota()]);
    usage = claude;
    render();
    broadcast();
    void invoke("set_tray_title", { title: trayTitle() });
    void guardClaude(usage);
  };
  void loadUsage();
  setInterval(() => void loadUsage(), USAGE_MS);
  const loadGemini = async () => {
    const got = await invoke<AgyWindow[]>("gemini_usage").catch(() => null);
    if (!got) return;
    geminiQuota = got;
    render();
    broadcast();
    void invoke("set_tray_title", { title: trayTitle() });
  };
  void loadGemini();
  setInterval(() => void loadGemini(), GEMINI_MS);
  window.addEventListener("dispecink-tray", () => void invoke("set_tray_title", { title: trayTitle() }));
  setInterval(() => void morning(), 60_000);
  const relay = startRelay({
    companies: () => (paperclip?.online ? paperclip.companies : []),
    overview: () => {
      const s = snapshot();
      return {
        focus,
        counts: s.counts,
        items: allItems().map((i) => ({
          id: i.id,
          name: i.name,
          state: i.state,
          chip: i.chip ?? STATES[i.state].chip,
          doing: i.doing,
          when: i.when,
          group: i.group,
          engine: i.engine ?? null,
          character: i.character,
          // What the phone may do with it: run, pause or resume a launchd job.
          job: i.id.startsWith("job:") ? i.id.slice(4) : null,
        })),
        bot: cfg.notchPrefs.bot ? cfg.characters.find((c) => c.id === cfg.notchPrefs.bot)?.character ?? null : null,
        live: [...s.live.map((l) => ({ id: l.id, name: l.name, lines: l.lines, character: l.character })), ...ccLive().map((l) => ({ ...l, id: "cc", character: { color: "#d97757", eyeColor: "#2a1610" } }))],
        // Where things run, by name, so the phone can group them like the sidebar.
        groups: groups.map((g) => ({ id: g.id, name: groupLabel(g) })),
        history: history.slice(-30).reverse().map((h) => ({ id: h.id, name: h.name, state: h.state, at: h.at, text: h.text })),
        prs: prList.map((pr) => {
          const all: Record<string, string>[] = pr.statusCheckRollup ?? [];
          const bad = all.some((c) => ["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED"].includes(c.conclusion ?? c.state ?? ""));
          const running = all.some((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING");
          return {
            repo: pr.repo,
            number: pr.number,
            title: pr.title,
            author: pr.author?.login ?? "",
            updatedAt: pr.updatedAt,
            url: pr.url,
            additions: pr.additions,
            deletions: pr.deletions,
            files: pr.changedFiles,
            draft: !!pr.isDraft,
            conflict: pr.mergeable === "CONFLICTING",
            ci: !all.length ? "none" : bad ? "bad" : running ? "run" : "ok",
            body: String(pr.body ?? "").slice(0, 1500),
          };
        }),
        limits: {
          claude: usage ? { session: usage.session?.percent ?? null, week: usage.week?.percent ?? null, resets: usage.session?.resets ?? "" } : null,
          gpt: gptQuota.map((w) => ({ percent: w.percent, windowSecs: w.windowSecs, resetsAtMs: w.resetsAtMs })),
          gemini: geminiQuota,
        },
      };
    },
    character: (id) => allItems().find((i) => i.id === id)?.character ?? {},
    toast: (t) => toast(t),
  });
  // A permission prompt, or its answer, goes to the phone at once, not at the next minute.
  void listen("cc-permission", () => void relay.push());
  void listen("cc-permission-done", () => void relay.push());
  void healCodex();
  setInterval(() => void healCodex(), 60 * 60_000);
  startPhone({
    chat: () => (cfg.telegram.enabled && cfg.telegram.remote !== false && cfg.telegram.chat ? cfg.telegram.chat : null),
    companies: () => (paperclip?.online ? paperclip.companies : []),
    status: () => {
      const items = allItems();
      const n = (st: State[]) => items.filter((i) => st.includes(i.state)).length;
      const waiting = items.filter((i) => ["you", "bad"].includes(i.state));
      return [
        `${n(["run"])} pracuje, ${n(["ok", "done"])} v pořádku, ${n(["sleep"])} spí.`,
        waiting.length ? `Čeká na tebe: ${waiting.map((i) => i.name).join(", ")}.` : "Nic na tebe nečeká.",
      ];
    },
    limits: () => {
      const out: string[] = [];
      if (usage?.session) out.push(`Claude: relace ${usage.session.percent} %${usage.week ? `, týden ${usage.week.percent} %` : ""}`);
      if (gptQuota[0]) out.push(`ChatGPT: ${windowName(gptQuota[0].windowSecs)} ${gptQuota[0].percent} %`);
      for (const w of geminiQuota) out.push(`${w.group === "Gemini" ? "Gemini" : "Claude v AI Pro"}: ${windowName(w.windowSecs)} ${w.percent} %`);
      return out;
    },
  });
  setInterval(() => void refresh(false), LOCAL_MS);
  setInterval(() => void refresh(true), CLOUD_MS);
}

$("refresh").addEventListener("click", () => void refresh(true));
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "r") {
    e.preventDefault();
    void refresh(true);
  } else if (e.key === "Escape") {
    select(null);
  }
});
window.addEventListener("focus", () => void refresh(false));

void start();
