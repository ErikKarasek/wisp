import { invoke } from "@tauri-apps/api/core";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { EXPRESSIONS } from "./mascot/mascot";
import { mascotSvg, mountMascot, type MountedMascot } from "./mascot/svg";
import {
  macGroup,
  paperclipGroups,
  SEVERITY,
  STATES,
  type ActionSpec,
  type Group,
  type Item,
  type Job,
  type PaperclipSnapshot,
  type State,
} from "./model";

const REFRESH_MS = 10_000;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let groups: Group[] = [];
let filter = "all";
let selected: string | null = null;

// ---------- data ----------

async function load(): Promise<Group[]> {
  const now = Date.now();
  const [jobs, snap] = await Promise.all([
    invoke<Job[]>("list_jobs").catch(() => [] as Job[]),
    invoke<PaperclipSnapshot>("paperclip_snapshot").catch((e) => ({ online: false, error: String(e) }) as PaperclipSnapshot),
  ]);
  return [macGroup(jobs, now), ...paperclipGroups(snap, now)];
}

const allItems = () => groups.flatMap((g) => g.items);

// ---------- cards ----------

type Card = { el: HTMLElement; mascot: MountedMascot; state: State };
const cards = new Map<string, Card>();
const groupEls = new Map<string, HTMLElement>();

function cardFor(item: Item, seed: number): Card {
  let card = cards.get(item.id);
  if (!card) {
    const el = document.createElement("div");
    el.className = "card";
    el.dataset.id = item.id;
    el.innerHTML = `<div class="bubble"></div><div class="m"></div>
      <div class="name"><span class="t"></span><span class="chip"></span></div>
      <div class="doing"></div><div class="when"></div>`;
    el.addEventListener("click", () => select(item.id));
    const mascot = mountMascot(el.querySelector(".m") as HTMLElement, {
      character: item.character,
      expression: STATES[item.state].expr,
      seed,
    });
    card = { el, mascot, state: item.state };
    cards.set(item.id, card);
  }
  const s = STATES[item.state];
  if (card.state !== item.state) {
    card.mascot.setExpression(s.expr);
    card.state = item.state;
  }
  const q = (sel: string) => card!.el.querySelector(sel) as HTMLElement;
  q(".t").textContent = item.name;
  q(".chip").textContent = item.chip ?? s.chip;
  q(".chip").className = `chip s-${item.state}`;
  q(".doing").textContent = item.doing;
  q(".doing").title = item.doing;
  q(".when").textContent = item.when;
  q(".bubble").textContent = item.bubble ?? "";
  card.el.classList.toggle("sel", item.id === selected);
  return card;
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
    sec.querySelector("h3")!.innerHTML = `${esc(g.title)} <em>${esc(g.note)}</em>`;
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

let legendDone = false;
function renderSide() {
  const items = allItems();
  const n = (f: (i: Item) => boolean) => items.filter(f).length;
  const rows: [string, string, number][] = [
    ["all", "Všichni", items.length],
    ["attention", "Potřebují tě", n((i) => ["bad", "you", "new"].includes(i.state))],
    ["run", "Pracují", n((i) => i.state === "run")],
    ["sleep", "Spí", n((i) => i.state === "sleep")],
  ];
  const where: [string, string, number][] = groups.map((g) => [g.id, g.id === "mac" ? "Mac" : g.note, g.items.length]);
  const btn = ([id, label, count]: [string, string, number]) =>
    `<button data-f="${esc(id)}" class="${filter === id ? "on" : ""}">${esc(label)}<span>${count}</span></button>`;
  const side = $("side");
  const legend = side.querySelector(".legend-wrap");
  side.innerHTML = rows.map(btn).join("") + `<h6>Kde běží</h6>` + where.map(btn).join("");
  side.querySelectorAll<HTMLButtonElement>("button[data-f]").forEach((b) =>
    b.addEventListener("click", () => {
      filter = b.dataset.f!;
      render();
    }),
  );
  if (legend) {
    side.appendChild(legend);
  } else if (!legendDone) {
    legendDone = true;
    const wrap = document.createElement("div");
    wrap.className = "legend-wrap";
    wrap.innerHTML = `<h6>Co znamená výraz</h6><div class="legend"></div>`;
    const list = wrap.querySelector(".legend")!;
    (["run", "ok", "done", "sleep", "you", "bad", "off"] as State[]).forEach((s, i) => {
      const row = document.createElement("div");
      row.className = "lg";
      row.innerHTML = `<div class="m"></div>${STATES[s].label}`;
      list.appendChild(row);
      mountMascot(row.querySelector(".m") as HTMLElement, { character: { color: "#8b9cff" }, expression: STATES[s].expr, seed: 70 + i });
    });
    side.appendChild(wrap);
  }
}

// ---------- detail ----------

let detailMascot: MountedMascot | null = null;
let detailFor: string | null = null;

function select(id: string | null) {
  selected = id;
  render();
}

async function renderDetail() {
  const detail = $("detail");
  const item = allItems().find((i) => i.id === selected);
  if (!item) {
    detail.hidden = true;
    detailMascot?.destroy();
    detailMascot = null;
    detailFor = null;
    return;
  }
  detail.hidden = false;
  if (detailFor !== item.id) {
    detailMascot?.destroy();
    detail.innerHTML = `<div class="m"></div><div class="info">
      <h4><span class="n"></span><span class="chip"></span><button class="icon-btn close" title="Zavřít (Esc)">✕</button></h4>
      <p class="d"></p><div class="facts"></div><pre class="log"></pre><div class="btns"></div></div>`;
    detail.querySelector(".close")!.addEventListener("click", () => select(null));
    detailMascot = mountMascot(detail.querySelector(".m") as HTMLElement, {
      character: item.character,
      expression: STATES[item.state].expr,
      seed: 5,
    });
    detailFor = item.id;
  } else {
    detailMascot?.setExpression(STATES[item.state].expr);
  }
  const q = (sel: string) => detail.querySelector(sel) as HTMLElement;
  q(".n").textContent = item.name;
  q(".chip").textContent = item.chip ?? STATES[item.state].chip;
  q(".chip").className = `chip s-${item.state}`;
  q(".d").textContent = `${item.doing} · ${item.when}`;
  q(".facts").innerHTML = item.facts.map(([k, v]) => `<span>${esc(k)}: <b>${esc(v)}</b></span>`).join("");

  const btns = q(".btns");
  if (btns.dataset.for !== item.id || btns.dataset.sig !== actionSig(item.actions)) {
    btns.dataset.for = item.id;
    btns.dataset.sig = actionSig(item.actions);
    btns.innerHTML = "";
    for (const a of item.actions) btns.appendChild(actionButton(a));
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
  try {
    if (c.type === "open") {
      if (/^https?:/.test(c.target)) await openUrl(c.target);
      else await openPath(c.target);
      return;
    }
    if (c.type === "job") await invoke("job_action", { label: c.label, action: c.action });
    else await invoke("paperclip_action", { kind: c.kind, id: c.id });
    toast(`${a.label}: hotovo`, true);
  } catch (e) {
    toast(String(e));
  }
  // launchd and Paperclip need a moment before the new state shows.
  setTimeout(refresh, 800);
  setTimeout(refresh, 3000);
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
}

let busy = false;
async function refresh() {
  if (busy) return;
  busy = true;
  $("refresh").classList.add("spin");
  try {
    groups = await load();
    render();
    await updateTray();
  } finally {
    busy = false;
    $("refresh").classList.remove("spin");
  }
}

$("refresh").addEventListener("click", refresh);
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "r") {
    e.preventDefault();
    void refresh();
  } else if (e.key === "Escape") {
    select(null);
  }
});
window.addEventListener("focus", () => void refresh());

void refresh();
setInterval(refresh, REFRESH_MS);
