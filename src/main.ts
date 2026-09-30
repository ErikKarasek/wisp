import { invoke } from "@tauri-apps/api/core";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { fullCharacter, loadConfig, saveConfig, type Config } from "./config";
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
  localGroups = [macGroup(jobs, now), ...paperclipGroups(snap, now)];
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
    default:
      return item.group === filter;
  }
}

function renderMain() {
  const main = $("main");
  const settings = $("settings");
  if (filter === "settings") {
    groupEls.forEach((s) => (s.hidden = true));
    settings.hidden = false;
    return;
  }
  settings.hidden = true;
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
      `${esc(g.title)} <em>${esc(g.note)}</em>` + (g.id === "mac" ? `<button class="add-job" data-act="newJob">+ Nová úloha</button>` : "");
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
  const btn = ([id, label, count]: [string, string, number | null]) =>
    `<button data-f="${esc(id)}" class="${filter === id ? "on" : ""}">${esc(label)}${count == null ? "" : `<span>${count}</span>`}</button>`;

  const neurons = cloudflare ? cloudflareNeurons(cloudflare) : null;
  const gauge =
    neurons == null
      ? ""
      : `<h6>Workers AI dnes</h6><div class="gauge${neurons >= NEURONS_PER_DAY * 0.9 ? " hot" : ""}"><div class="bar"><i style="width:${Math.min(100, (neurons / NEURONS_PER_DAY) * 100).toFixed(1)}%"></i></div>
         <small>${Math.round(neurons).toLocaleString("cs-CZ")} z ${NEURONS_PER_DAY.toLocaleString("cs-CZ")} neuronů</small></div>`;

  const side = $("side");
  side.innerHTML =
    rows.map(btn).join("") +
    `<h6>Kde běží</h6>` +
    where.map(btn).join("") +
    gauge +
    `<h6>Tvoje</h6>` +
    `<button data-act="studio">Postavičky<span>${cfg.characters.length}</span></button>` +
    `<button data-act="newJob">Nová úloha</button>` +
    btn(["settings", "Nastavení", null]);
  side.querySelectorAll<HTMLButtonElement>("button[data-f]").forEach((b) =>
    b.addEventListener("click", () => {
      filter = b.dataset.f!;
      if (filter === "settings") selected = null;
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
      <p class="d"></p><div class="facts"></div><div class="history"></div><pre class="log"></pre><div class="btns"></div></div>`;
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
    : `<span class="h empty">Zatím žádné změny. Historie se zapisuje, dokud Dispečink běží.</span>`;

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
  if (!item.log) {
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

  const alarming = changed.filter((i) => i.state === "bad" || i.state === "you");
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
    const text = ["Dispečink", ...alarming.map((i) => `• ${title(i)}\n  ${i.doing}`)].join("\n");
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
  if ((e.target as HTMLElement).closest('[data-act="newJob"]')) jobForm();
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
  if (!lines.length) lines.push("Všechno v pořádku");
  const tooltip = attention.length ? `Dispečink: ${attention.length} potřebuje pozornost` : "Dispečink: všechno v pořádku";
  const sig = `${face}|${lines.join("|")}`;
  if (sig === traySig) return;
  traySig = sig;
  try {
    const png = await renderPng(mascotSvg({ color: "#e6e8ef", eyeColor: "#15161a" }, EXPRESSIONS[face], 44), 44);
    await invoke("set_tray", { png: Array.from(png), tooltip, lines });
  } catch (e) {
    console.error("tray", e);
    traySig = "";
  }
}

async function renderPng(svg: string, size: number): Promise<Uint8Array> {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await img.decode();
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  canvas.getContext("2d")!.drawImage(img, 0, 0, size, size);
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
}

let settingsShown = false;
async function showSettings() {
  settingsShown = true;
  await renderSettings($("settings"), {
    cfg,
    save: async () => {
      await saveConfig(cfg);
    },
    cloudflare,
    refreshCloud: () => refresh(true),
    openStudio: () => studio(),
    toast,
  });
}

let busy = false;
let cloudPending = false;
async function refresh(withCloud = false): Promise<void> {
  if (busy) {
    // Don't lose a cloud refresh that arrives while a local one runs.
    cloudPending ||= withCloud;
    return;
  }
  busy = true;
  $("refresh").classList.add("spin");
  try {
    await Promise.all([loadLocal(), withCloud ? loadCloud() : Promise.resolve()]);
    compose();
    render();
    await Promise.all([updateTray(), onChanges()]);
  } finally {
    busy = false;
    $("refresh").classList.remove("spin");
  }
  if (cloudPending) {
    cloudPending = false;
    await refresh(true);
  }
}

async function start() {
  cfg = await loadConfig();
  history = await invoke<HistoryEntry[]>("history_load").catch(() => []);
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
