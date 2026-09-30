// The two small views: the panel under the menu-bar icon, and the mascot in
// the notch. Both only show what the main window broadcasts.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { EXPRESSIONS, type ExpressionName, type MascotCharacter } from "./mascot/mascot";
import { mountMascot, type MountedMascot } from "./mascot/svg";
import { EV_NOTCH_PREFS, EV_OPEN, EV_OPEN_SETTINGS, EV_REFRESH, EV_REQUEST, EV_STATE, type MiniItem, type Snapshot, windowName, resetText, claudeResetMs, elapsedPercent } from "./broadcast";
import { defaultNotchPrefs, type NotchPrefs, type SavedCharacter } from "./config";
import { SEVERITY, STATES, type State } from "./model";
import { sounds } from "./sounds";
import "./mini.css";

const escHtml = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const byUrgency = (a: MiniItem, b: MiniItem) => SEVERITY.indexOf(a.state) - SEVERITY.indexOf(b.state);

function worst(s: Snapshot): State {
  return SEVERITY.find((st) => s.items.some((i) => i.state === st)) ?? "ok";
}

function faceFor(state: State): ExpressionName {
  return state === "bad" ? "angry" : state === "you" || state === "new" ? "curious" : state === "run" ? "thriving" : "happy";
}

function headline(s: Snapshot): string {
  const bad = s.items.filter((i) => i.state === "bad");
  if (bad.length === 1) return `${bad[0].name}: selhal`;
  if (bad.length > 1) return `${bad.length} selhali`;
  if (s.counts.attention) return s.counts.attention === 1 ? `${s.items.find((i) => i.state === "you" || i.state === "new")?.name} na tebe čeká` : `${s.counts.attention} na tebe čekají`;
  if (s.counts.run) return s.counts.run === 1 ? `${s.items.find((i) => i.state === "run")?.name} pracuje` : `${s.counts.run} pracují`;
  return "Všechno v pořádku";
}

/** A list of small rows with their own living mascots, reused between updates. */
function rowList(container: HTMLElement) {
  const rows = new Map<string, { el: HTMLElement; mascot: MountedMascot; state: State; look: string }>();
  return (items: MiniItem[]) => {
    const seen = new Set<string>();
    items.forEach((item, i) => {
      seen.add(item.id);
      let row = rows.get(item.id);
      const look = JSON.stringify(item.character);
      if (!row || row.look !== look) {
        row?.mascot.destroy();
        row?.el.remove();
        const el = document.createElement("button");
        el.className = "mrow";
        el.innerHTML = `<div class="m"></div><div class="t"><b></b><small></small></div><span class="chip"></span>`;
        el.addEventListener("click", () => void emit(EV_OPEN, { id: item.id }));
        const mascot = mountMascot(el.querySelector(".m") as HTMLElement, { character: item.character, expression: STATES[item.state].expr, seed: i * 13 + 3 });
        row = { el, mascot, state: item.state, look };
        rows.set(item.id, row);
      }
      if (row.state !== item.state) {
        row.mascot.setExpression(STATES[item.state].expr);
        row.state = item.state;
      }
      (row.el.querySelector("b") as HTMLElement).textContent = item.name;
      (row.el.querySelector("small") as HTMLElement).textContent = item.doing;
      const chip = row.el.querySelector(".chip") as HTMLElement;
      chip.textContent = item.chip;
      chip.className = `chip s-${item.state}`;
      container.appendChild(row.el);
    });
    for (const [id, row] of rows) {
      if (!seen.has(id)) {
        row.mascot.destroy();
        row.el.remove();
        rows.delete(id);
      }
    }
  };
}

function subscribe(onState: (s: Snapshot) => void) {
  void listen<Snapshot>(EV_STATE, (e) => onState(e.payload));
  void emit(EV_REQUEST);
}

// ---------- menu-bar panel ----------

export function startPanel() {
  document.body.innerHTML = `
    <div class="pn">
      <header><div class="m face"></div><div><b>Dispečink</b><small class="head">Načítám…</small></div></header>
      <div class="tiles">
        <div class="tile s-you"><b data-c="attention">–</b><small>čeká na tebe</small></div>
        <div class="tile s-run"><b data-c="run">–</b><small>pracuje</small></div>
        <div class="tile s-sleep"><b data-c="sleep">–</b><small>spí</small></div>
        <div class="tile s-off"><b data-c="off">–</b><small>vypnuto</small></div>
      </div>
      <div class="list"></div>
      <footer>
        <button data-act="open">Otevřít Dispečink</button>
        <button data-act="refresh" title="Obnovit">↻</button>
        <button data-act="quit" title="Ukončit Dispečink">Ukončit</button>
      </footer>
    </div>`;
  const face = mountMascot(document.querySelector(".face") as HTMLElement, { expression: "happy", seed: 4 });
  const render = rowList(document.querySelector(".list") as HTMLElement);
  subscribe((s) => {
    face.setExpression(faceFor(worst(s)));
    (document.querySelector(".head") as HTMLElement).textContent = headline(s);
    for (const [k, v] of Object.entries(s.counts)) {
      const el = document.querySelector(`[data-c="${k}"]`);
      if (el) el.textContent = String(v);
    }
    // What needs you or is working first, then the rest.
    render([...s.items].sort(byUrgency).slice(0, 7));
  });
  document.querySelector("footer")!.addEventListener("click", (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "open") void invoke("show_main_window");
    if (act === "refresh") void emit(EV_REFRESH);
    if (act === "quit") void invoke("quit_app");
  });
}

// ---------- notch ----------

type NowPlaying = { app: string; playing: boolean; title: string; artist: string; album: string; artworkUrl: string | null; position: number; duration: number };
type CalEvent = { title: string; startMs: number; endMs: number; allDay: boolean; calendar: string; location: string };
type Cfg = { sounds?: boolean; characters?: SavedCharacter[]; notchPrefs?: Partial<NotchPrefs> };

const CAMERA = `<svg viewBox="0 0 24 24"><circle cx="12" cy="10" r="6"/><circle cx="12" cy="10" r="2.2"/><path d="M8 20h8M12 16v4"/></svg>`;
const GEAR = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/></svg>`;
const CAL_EMPTY = `<svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/><circle cx="17.5" cy="17.5" r="4.2" class="ok"/><path d="m15.8 17.6 1.2 1.2 2.3-2.4" class="tick"/></svg>`;
const BADGE: Record<string, string> = {
  Spotify: `<span class="badge spotify"><svg viewBox="0 0 24 24"><path d="M6.5 9.5c3.8-1.2 7.6-.9 11 .9M7.2 12.8c3-1 6.2-.7 9 .8M8 15.8c2.4-.7 4.6-.5 6.7.6"/></svg></span>`,
  Music: `<span class="badge music"><svg viewBox="0 0 24 24"><path d="M10 17V7l8-2v10"/><circle cx="8" cy="17" r="2"/><circle cx="16" cy="15" r="2"/></svg></span>`,
};
const MONTHS = ["led", "úno", "bře", "dub", "kvě", "čvn", "čvc", "srp", "zář", "říj", "lis", "pro"];
const DAYS = ["ne", "po", "út", "st", "čt", "pá", "so"];
const DAY = 86_400_000;
const hm = (ms: number) => new Date(ms).toLocaleTimeString("cs-CZ", { hour: "numeric", minute: "2-digit" });
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const midnight = (ms: number) => new Date(new Date(ms).toDateString()).getTime();
const WHITE_BOT: Partial<MascotCharacter> = { color: "#e6e8ef", eyeColor: "#15161a" };

export async function startNotch() {
  const g = await invoke<{ notchWidth: number; barHeight: number; hasNotch: boolean }>("notch_geometry");
  let cfg = await invoke<Cfg>("config_load").catch(() => ({}) as Cfg);
  let prefs: NotchPrefs = { ...defaultNotchPrefs(), ...(cfg.notchPrefs ?? {}) };

  document.body.innerHTML = `
    <div class="nt">
      <div class="bar">
        <div class="side l">
          <div class="closed-only lw"><div class="m tiny"></div><span class="lname"></span></div>
          <div class="open-only sum"></div>
        </div>
        <div class="gap"></div>
        <div class="side r">
          <span class="closed-only rw"><span class="lstep"></span><span class="st"></span><span class="lim" hidden></span></span>
          <div class="open-only icons">
            <span class="ring cl" hidden><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" class="track"/><circle cx="18" cy="18" r="14" class="fill"/></svg><b></b></span>
            <span class="ring gem" hidden><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" class="track"/><circle cx="18" cy="18" r="14" class="fill"/></svg><b></b></span>
            <span class="ring gpt" hidden><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="14" class="track"/><circle cx="18" cy="18" r="14" class="fill"/></svg><b></b></span>
            <button data-act="mirror" title="Kamera">${CAMERA}</button>
            <button data-act="settings" title="Nastavení notche">${GEAR}</button>
          </div>
        </div>
      </div>
      <div class="panes gone">
        <div class="card hero">
          <div class="big-wrap"><div class="m big"></div><span class="dots" hidden><i></i><i></i><i></i></span></div>
          <div class="steps"></div>
          <div class="crew"></div>
        </div>
        <div class="card music"></div>
        <div class="card cal"><div class="cal-head"><div class="my"><b></b><span></span></div><div class="week"></div></div><div class="cal-body"></div></div>
        <div class="card mirror" hidden><video autoplay playsinline muted></video><p class="muted"></p></div>
      </div>
    </div>`;
  const root = document.querySelector(".nt") as HTMLElement;
  root.style.setProperty("--bar-h", `${g.barHeight}px`);
  root.style.setProperty("--gap", g.hasNotch ? `${Math.round(g.notchWidth)}px` : "88px");
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const panes = $(".panes");

  // ----- the bot -----
  const botLook = () => {
    const saved = prefs.bot ? cfg.characters?.find((c) => c.id === prefs.bot) : null;
    return saved ? saved.character : WHITE_BOT;
  };
  const tiny = mountMascot($(".m.tiny"), { character: botLook(), expression: "happy", transition: 180, seed: 21 });
  const big = mountMascot($(".m.big"), { character: botLook(), expression: "happy", transition: 200, seed: 22 });
  let base: ExpressionName = "happy";
  let look: [number, number] = [0, 0];
  let reacting = 0;
  let dancing = false;
  const face = () => {
    if (Date.now() < reacting) return;
    const ex = EXPRESSIONS[dancing && prefs.dance && base === "happy" ? "thriving" : base];
    const shaped = prefs.follow ? { ...ex, lookX: look[0], lookY: look[1] * 0.85, wander: 0 } : ex;
    tiny.setExpression(shaped);
    big.setExpression(shaped);
  };
  void listen<[number, number]>("notch-look", (e) => {
    look = e.payload;
    if (prefs.follow) face();
  });

  let pokes: number[] = [];
  for (const el of [$(".m.tiny"), $(".m.big")]) {
    el.addEventListener("click", () => {
      const now = Date.now();
      pokes = pokes.filter((t) => now - t < 2500).concat(now);
      const n = pokes.length;
      el.classList.remove("hop", "dizzy");
      void el.offsetWidth;
      el.classList.add(n >= 5 ? "dizzy" : "hop");
      reacting = now + 1100;
      const ex = n >= 5 ? "angry" : n >= 3 ? "happy" : "surprised";
      tiny.setExpression(ex);
      big.setExpression(ex);
      if (cfg.sounds !== false) sounds.poke(n >= 5 ? 0.6 : 1 + n * 0.08);
      if (n >= 5) pokes = [];
      setTimeout(face, 1150);
    });
  }

  // ----- open and close -----
  // When closed, the cards leave the page entirely: a transparent WebKit window
  // otherwise keeps faint ghosts of layers that were only faded out.
  let goneTimer = 0;
  void listen<boolean>("notch-open", (e) => {
    clearTimeout(goneTimer);
    if (e.payload) {
      panes.classList.remove("gone");
      void panes.offsetWidth; // let the cards exist for a frame before they animate in
      root.classList.add("is-open");
    } else {
      root.classList.remove("is-open");
      closeMirror();
      goneTimer = window.setTimeout(() => panes.classList.add("gone"), 360);
    }
  });

  // ----- settings -----
  const applyPrefs = () => {
    $(".crew").hidden = !prefs.showOthers;
    $(".music").hidden = !prefs.showMusic;
    $(".cal").hidden = !prefs.showCalendar;
    ($("[data-act=mirror]") as HTMLElement).hidden = !prefs.showMirror;
    if (!prefs.showMirror) closeMirror();
    tiny.setCharacter(botLook());
    big.setCharacter(botLook());
    root.classList.toggle("dancing", dancing && prefs.dance);
    face();
  };
  void listen(EV_NOTCH_PREFS, async () => {
    cfg = await invoke<Cfg>("config_load").catch(() => cfg);
    prefs = { ...defaultNotchPrefs(), ...(cfg.notchPrefs ?? {}) };
    applyPrefs();
    void loadCalendar();
  });
  $("[data-act=settings]").addEventListener("click", () => void emit(EV_OPEN_SETTINGS));

  // ----- the bot's card: what the working agent does, and the rest as a row of faces -----
  const steps = $(".steps");
  const crew = $(".crew");
  const crewMascots = new Map<string, MountedMascot>();
  const LIVE_WING = 170;
  const arc = (r: number, pct: number) => {
    const len = 2 * Math.PI * r;
    return `stroke-dasharray="${((Math.min(100, pct) / 100) * len).toFixed(2)} ${len.toFixed(2)}"`;
  };
  const ahead = (used: number, elapsed: number | null) => elapsed != null && used > elapsed + 10;
  // Beside the closed notch space is short (the menu-bar icons live there), so
  // a number shows only once a limit gets close; the open notch has them all.
  const num = (pct: number) => (pct >= 80 ? `<b>${pct}</b>` : "");
  function limitsHtml(s: Snapshot): string {
    const out: string[] = [];
    const ses = s.usage?.session;
    const week = s.usage?.week;
    if (ses || week) {
      const sesAhead = ses ? ahead(ses.percent, elapsedPercent(claudeResetMs(ses.resets), 5 * 3600)) : false;
      out.push(`<span class="li cl${sesAhead ? " fast" : ""}"><svg viewBox="0 0 20 20">
        ${week ? `<circle cx="10" cy="10" r="8.5" class="tr"/><circle cx="10" cy="10" r="8.5" class="fl wk" ${arc(8.5, week.percent)}/>` : ""}
        ${ses ? `<circle cx="10" cy="10" r="5" class="tr"/><circle cx="10" cy="10" r="5" class="fl" ${arc(5, ses.percent)}/>` : ""}
      </svg>${num(ses?.percent ?? week?.percent ?? 0)}</span>`);
    }
    // Gemini (Antigravity): like Claude, the 5 h window inside the week.
    const g5 = s.gemini?.find((w) => w.group === "Gemini" && w.windowSecs === 5 * 3600);
    const gw = s.gemini?.find((w) => w.group === "Gemini" && w.windowSecs === 7 * 86400);
    if (g5 || gw) {
      const gemAhead = g5 ? ahead(g5.percent, elapsedPercent(g5.resetsAtMs, g5.windowSecs)) : false;
      out.push(`<span class="li gm${gemAhead ? " fast" : ""}"><svg viewBox="0 0 20 20">
        ${gw ? `<circle cx="10" cy="10" r="8.5" class="tr"/><circle cx="10" cy="10" r="8.5" class="fl wk" ${arc(8.5, gw.percent)}/>` : ""}
        ${g5 ? `<circle cx="10" cy="10" r="5" class="tr"/><circle cx="10" cy="10" r="5" class="fl" ${arc(5, g5.percent)}/>` : ""}
      </svg>${num(g5?.percent ?? gw?.percent ?? 0)}</span>`);
    }
    const g = s.gpt?.[0];
    if (g) {
      const gAhead = ahead(g.percent, elapsedPercent(g.resetsAtMs, g.windowSecs));
      out.push(`<span class="li gp${gAhead ? " fast" : ""}"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7" class="tr"/><circle cx="10" cy="10" r="7" class="fl" ${arc(7, g.percent)}/></svg>${num(g.percent)}</span>`);
    }
    return out.join("");
  }
  let lastWing = 46;

  // ----- Claude Code in a terminal: its hooks post to Dispečink, which passes them here -----
  type CcEvent = { session: string; project: string; kind: string; text: string };
  type Perm = { id: string; session: string; project: string; tool: string; detail: string; rule: string };
  const ccSessions = new Map<string, { project: string; lines: string[]; at: number; since: number; busy: boolean }>();
  let ccDone: { project: string; text: string; at: number } | null = null;
  let perms: Perm[] = [];
  let permShown: string | null = null;
  const ccWorking = () => {
    const now = Date.now();
    const [id, v] = [...ccSessions.entries()].filter(([, v]) => v.busy && now - v.at < 120_000).sort((a, b) => b[1].at - a[1].at)[0] ?? [];
    return v ? { id: `cc:${id}`, name: `${v.project} · Claude`, character: {}, lines: v.lines } : undefined;
  };
  void listen<CcEvent>("cc-event", (e) => {
    const { session, project, kind, text } = e.payload;
    const now = Date.now();
    if (kind === "end") {
      ccSessions.delete(session);
      return redraw();
    }
    const cur = ccSessions.get(session) ?? { project, lines: [], at: now, since: now, busy: false };
    cur.project = project;
    cur.at = now;
    if (kind === "prompt") {
      cur.busy = true;
      cur.since = now;
      cur.lines = text ? [`› ${text}`] : [];
    } else if (kind === "step") {
      if (!cur.busy) cur.since = now;
      cur.busy = true;
      cur.lines = [...cur.lines, text].slice(-6);
    } else if (kind === "done") {
      // Only a turn that took a while is worth a sound and a peek.
      const long = cur.busy && now - cur.since > 30_000;
      cur.busy = false;
      ccDone = { project, text, at: now };
      if (long) {
        if (cfg.sounds !== false) sounds.done();
        void invoke("notch_peek", { millis: 5000 });
      }
    } else if (kind === "waiting") {
      cur.busy = false;
    }
    ccSessions.set(session, cur);
    redraw();
  });
  void listen<Perm>("cc-permission", (e) => {
    perms = [...perms.filter((p) => p.id !== e.payload.id), e.payload];
    if (cfg.sounds !== false) sounds.you();
    redraw();
  });
  void listen<string>("cc-permission-done", (e) => {
    perms = perms.filter((p) => p.id !== e.payload);
    redraw();
  });
  // A permission prompt from Claude Code: allow, always, deny, or leave it to the terminal.
  function renderPerm() {
    const p = perms[0];
    if (permShown === p.id) return;
    permShown = p.id;
    const tool = p.tool === "Bash" ? "chce spustit" : p.tool === "Edit" || p.tool === "Write" || p.tool === "MultiEdit" ? "chce upravit" : `chce použít ${p.tool}`;
    steps.innerHTML = `<small class="who warn">${escHtml(p.project)} · Claude ${tool}${perms.length > 1 ? ` <i>(+${perms.length - 1})</i>` : ""}</small>
      <div class="step now cmd">${escHtml(p.detail)}</div>
      <div class="perm">
        <button data-a="deny">Zamítnout</button>
        <button data-a="terminal" title="Nech to na terminálu">Terminál</button>
        <button data-a="always" title="Povolit i příště: ${escHtml(p.rule)}">Vždy</button>
        <button data-a="allow" class="go">Povolit</button>
      </div>`;
    steps.querySelectorAll<HTMLButtonElement>("[data-a]").forEach((b) =>
      b.addEventListener("click", () => {
        void invoke("cc_decide", { id: p.id, answer: b.dataset.a });
        perms = perms.filter((x) => x.id !== p.id);
        permShown = null;
        redraw();
      }),
    );
  }

  // ----- a file dropped on the notch, and a question about it (Gemini answers) -----
  let fileAsk: { path: string; name: string } | null = null;
  void getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload;
    if (p.type === "enter" || p.type === "over") root.classList.add("dropping");
    else if (p.type === "leave") root.classList.remove("dropping");
    else if (p.type === "drop") {
      root.classList.remove("dropping");
      if (p.paths[0]) showFile(p.paths[0]);
    }
  });
  function showFile(path: string) {
    const name = path.split("/").pop() ?? path;
    fileAsk = { path, name };
    quickAsk = false;
    permShown = null;
    steps.innerHTML = `<small class="who">${escHtml(name)}<button class="x" title="Zavřít">✕</button></small>
      <div class="step past wrap reply">Na co se chceš zeptat? Odpoví Gemini z tvého AI Pro.</div>
      <div class="answer"><input type="text" placeholder="Třeba: kolik to dělá celkem?" spellcheck="false"><button>Zeptat se</button></div>`;
    const input = steps.querySelector("input") as HTMLInputElement;
    const go = steps.querySelector(".answer button") as HTMLButtonElement;
    const reply = steps.querySelector(".reply") as HTMLElement;
    input.focus();
    steps.querySelector(".x")!.addEventListener("click", () => {
      fileAsk = null;
      redraw();
    });
    const ask = async () => {
      const q = input.value.trim();
      if (!q || go.disabled) return;
      go.disabled = true;
      reply.textContent = "Gemini čte soubor…";
      try {
        const text = await invoke<string>("ask_file", { path, question: q });
        reply.textContent = text.replace(/\*\*|__|`/g, "");
        input.value = "";
        input.placeholder = "Další otázka…";
      } catch (err) {
        reply.textContent = String(err);
      }
      go.disabled = false;
      void invoke("notch_peek", { millis: 8000 });
    };
    go.addEventListener("click", () => void ask());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void ask();
    });
  }

  // ----- ⌃⌥Space: a quick question, with whatever was copied as its context -----
  let quickAsk = false;
  const closeQuick = () => {
    quickAsk = false;
    redraw();
  };
  void listen<string>("quick-ask", (e) => {
    quickAsk = true;
    fileAsk = null;
    permShown = null;
    let clip = e.payload.trim();
    const preview = clip.replace(/\s+/g, " ").slice(0, 90);
    steps.innerHTML = `<small class="who">Rychlá otázka · Gemini<button class="x" title="Zavřít (Esc)">✕</button></small>
      ${clip ? `<div class="step past clip">Zkopírováno: „${escHtml(preview)}${clip.length > 90 ? "…" : ""}“ <button class="drop-clip">nepoužít</button></div>` : ""}
      <div class="step past wrap reply"></div>
      <div class="answer"><input type="text" placeholder="${clip ? "Třeba: přelož do angličtiny, vysvětli, shrň" : "Na co se chceš zeptat?"}" spellcheck="false"><button>Zeptat se</button></div>`;
    const input = steps.querySelector("input") as HTMLInputElement;
    const go = steps.querySelector(".answer button") as HTMLButtonElement;
    const reply = steps.querySelector(".reply") as HTMLElement;
    steps.querySelector(".x")!.addEventListener("click", closeQuick);
    steps.querySelector(".drop-clip")?.addEventListener("click", () => {
      clip = "";
      steps.querySelector(".clip")?.remove();
      input.placeholder = "Na co se chceš zeptat?";
      input.focus();
    });
    const ask = async () => {
      const q = input.value.trim();
      if (!q || go.disabled) return;
      go.disabled = true;
      reply.textContent = "Gemini přemýšlí…";
      try {
        const text = (await invoke<string>("ask_quick", { question: q, context: clip })).replace(/\*\*|__|`/g, "");
        reply.innerHTML = `${escHtml(text)} <button class="copy">Kopírovat</button>`;
        reply.querySelector(".copy")!.addEventListener("click", async (ev) => {
          await navigator.clipboard.writeText(text).catch(() => {});
          (ev.target as HTMLButtonElement).textContent = "Zkopírováno";
        });
        input.value = "";
        input.placeholder = "Další otázka…";
      } catch (err) {
        reply.textContent = String(err);
      }
      go.disabled = false;
      input.focus();
    };
    go.addEventListener("click", () => void ask());
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") void ask();
      if (ev.key === "Escape") closeQuick();
    });
    setTimeout(() => input.focus(), 60);
  });

  let lastSnap: Snapshot | null = null;
  const redraw = () => {
    if (lastSnap) draw(lastSnap);
  };
  const draw = (s: Snapshot) => {
    lastSnap = s;
    base = faceFor(worst(s));
    face();
    const bad = s.items.filter((i) => i.state === "bad").length;
    const st = $(".st");
    const music = dancing && prefs.showMusic;
    const running = s.counts.run > 0 || !!ccWorking();
    st.className = `st s-${music ? "music" : bad ? "bad" : s.counts.attention ? "you" : running ? "run" : "ok"}`;
    st.innerHTML = music ? `<i></i><i></i><i></i><i></i>` : bad ? `${bad}` : s.counts.attention ? `${s.counts.attention}` : running ? `<i></i><i></i><i></i>` : "✓";
    $(".sum").textContent = headline(s);

    const working = s.live?.[0] ?? ccWorking();
    ($(".dots") as HTMLElement).hidden = !working;

    // Live activity: while an agent works, the closed notch widens to show it.
    // The limits stay beside the notch all the time, like Codenotch: Claude's
    // session inside its week, and ChatGPT. A number turns amber when it runs
    // ahead of the time gone in its window.
    const lim = $(".lim");
    const limits = limitsHtml(s);
    lim.hidden = !prefs.showLimits || !limits;
    if (!lim.hidden && lim.innerHTML !== limits) lim.innerHTML = limits;
    // A ring takes ~21 px, and ~17 more with its number.
    const extra = lim.hidden ? 0 : (limits.match(/class="li /g)?.length ?? 0) * 21 + (limits.match(/<b>/g)?.length ?? 0) * 17 + 4;
    // Only Paperclip agents widen the notch with their step; Claude Code in a
    // terminal shows its dots here and the steps in the open notch.
    const wide = !!s.live?.[0];
    const wing = (wide ? LIVE_WING : 46) + extra;
    if (wing !== lastWing) {
      lastWing = wing;
      root.style.setProperty("--wing", `${wing}px`);
      root.classList.toggle("live", wide);
      void invoke("notch_set_wing", { width: wing });
    }
    if (wide && working) {
      $(".lname").textContent = working.name;
      $(".lstep").textContent = working.lines.at(-1) ?? "";
    }
    const fresh = s.news && Date.now() - s.at < 15_000 ? s.news : null;
    // Claude's limit as a ring: the session, with the week in the tooltip.
    const ring = $(".ring.cl");
    ring.hidden = !s.usage?.session;
    if (s.usage?.session) {
      const pct = s.usage.session.percent;
      ring.querySelector<SVGCircleElement>(".fill")!.style.strokeDasharray = `${(pct / 100) * 88} 88`;
      ring.classList.toggle("hot", pct >= 85);
      (ring.querySelector("b") as HTMLElement).textContent = `${pct}`;
      ring.title = `Claude: ${pct} % relace (obnoví se ${s.usage.session.resets})` + (s.usage.week ? `\nTýden: ${s.usage.week.percent} % (obnoví se ${s.usage.week.resets})` : "");
    }
    // Gemini (Antigravity) in blue: its 5 h window, the week and AI Pro's Claude in the tooltip.
    const gem = $(".ring.gem");
    const gem5 = s.gemini?.find((w) => w.group === "Gemini" && w.windowSecs === 5 * 3600);
    gem.hidden = !gem5;
    if (gem5) {
      gem.querySelector<SVGCircleElement>(".fill")!.style.strokeDasharray = `${(gem5.percent / 100) * 88} 88`;
      gem.classList.toggle("hot", gem5.percent >= 85);
      (gem.querySelector("b") as HTMLElement).textContent = `${gem5.percent}`;
      gem.title = s.gemini
        .map((w) => `${w.group === "Gemini" ? "Gemini" : "Claude v AI Pro"} ${windowName(w.windowSecs)}: ${w.percent} %${w.resetsAtMs ? ` (obnoví se ${resetText(w.resetsAtMs)})` : ""}`)
        .join("\n");
    }
    // ChatGPT's limit next to it, in its green.
    const gpt = $(".ring.gpt");
    const win = s.gpt?.[0];
    gpt.hidden = !win;
    if (win) {
      const pct = win.percent;
      gpt.querySelector<SVGCircleElement>(".fill")!.style.strokeDasharray = `${(pct / 100) * 88} 88`;
      gpt.classList.toggle("hot", pct >= 85);
      (gpt.querySelector("b") as HTMLElement).textContent = `${pct}`;
      gpt.title = s.gpt.map((w, i) => `${i ? "" : "ChatGPT: "}${windowName(w.windowSecs)} ${w.percent} %${w.resetsAtMs ? ` (obnoví se ${resetText(w.resetsAtMs)})` : ""}`).join("\n");
    }

    // Claude Code asking for permission comes first, then a dropped file.
    root.classList.toggle("asking", perms.length > 0);
    if (perms.length) {
      renderPerm();
      return renderCrew(s, working);
    }
    permShown = null;
    if (fileAsk || quickAsk) return renderCrew(s, working);
    const doneCc = !working && ccDone && Date.now() - ccDone.at < 15_000 ? ccDone : null;

    const asking = !working && !(fresh && fresh.id === "morning") ? s.items.find((i) => i.ask) : undefined;
    if (asking?.ask) {
      if (askFor !== asking.ask.issueId) showAsk(asking);
      return renderCrew(s, working);
    }
    askFor = null;
    if (working) {
      const lines = working.lines.slice(-3);
      while (lines.length < 3) lines.unshift("");
      steps.innerHTML =
        `<small class="who">${escHtml(working.name)} pracuje</small>` +
        lines.map((l, i) => `<div class="step ${i === lines.length - 1 ? "now" : "past"}">${i === lines.length - 1 ? "›_ " : ""}${escHtml(l)}</div>`).join("");
    } else if (doneCc) {
      steps.innerHTML = `<small class="who">${escHtml(doneCc.project)} · Claude</small><div class="step now big-text">Hotovo</div><div class="step past wrap">${escHtml(doneCc.text)}</div>`;
    } else if (fresh) {
      steps.innerHTML = `<small class="who">${escHtml(fresh.name)}</small><div class="step now big-text">${escHtml(fresh.chip)}</div><div class="step past${fresh.id === "morning" ? " wrap" : ""}">${escHtml(fresh.doing)}</div>`;
    } else {
      steps.innerHTML = `<small class="who">Dispečink</small><div class="step now big-text">${escHtml(headline(s))}</div><div class="step past">${s.counts.run} pracuje · ${s.counts.sleep} spí</div>`;
    }

    renderCrew(s, working);
  };
  subscribe(draw);

  // An agent that waits on you: its question, and a box to answer it right here.
  let askFor: string | null = null;
  async function showAsk(item: MiniItem) {
    const ask = item.ask!;
    askFor = ask.issueId;
    steps.innerHTML = `<small class="who">${escHtml(item.name)} se ptá</small><div class="step now big-text small">${escHtml(ask.title)}</div>
      <div class="step past wrap q">…</div>
      <div class="answer"><input type="text" placeholder="Odpověz ${escHtml(item.name)}…" spellcheck="false"><button>Poslat</button></div>`;
    const comments = await invoke<Record<string, any>[] | { items: Record<string, any>[] }>("paperclip_request", { method: "GET", path: `/issues/${ask.issueId}/comments`, body: null }).catch(() => []);
    const list = Array.isArray(comments) ? comments : comments.items;
    const last = [...list].reverse().find((c) => c.authorAgentId);
    const q = steps.querySelector(".q");
    if (q) q.textContent = (last?.body ?? "").replace(/[*`#>]/g, "").replace(/\s+/g, " ").slice(0, 240) || "Otevři úkol v Dispečinku.";
    const input = steps.querySelector("input") as HTMLInputElement;
    const send = steps.querySelector(".answer button") as HTMLButtonElement;
    const go = async () => {
      const text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      try {
        await invoke("paperclip_request", { method: "POST", path: `/issues/${ask.issueId}/comments`, body: { body: text } });
        await invoke("paperclip_request", { method: "PATCH", path: `/issues/${ask.issueId}`, body: { status: "todo" } });
        await invoke("paperclip_action", { kind: "agentInvoke", id: ask.agentId });
        steps.innerHTML = `<small class="who">${escHtml(item.name)}</small><div class="step now big-text">Posláno</div><div class="step past">${escHtml(item.name)} se k tomu hned vrátí.</div>`;
        void emit(EV_REFRESH);
      } catch (err) {
        send.disabled = false;
        (steps.querySelector(".q") as HTMLElement).textContent = String(err);
      }
    };
    send.addEventListener("click", () => void go());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void go();
    });
  }

  function renderCrew(s: Snapshot, working: Snapshot["live"][number] | undefined) {
    const others = [...s.items].filter((i) => i.id !== working?.id).sort(byUrgency).slice(0, 7);
    const seen = new Set<string>();
    others.forEach((i, n) => {
      seen.add(i.id);
      let face = crew.querySelector<HTMLElement>(`[data-id="${CSS.escape(i.id)}"]`);
      if (!face) {
        face = document.createElement("button");
        face.className = "mate";
        face.dataset.id = i.id;
        face.innerHTML = `<span class="m"></span><i></i>`;
        face.addEventListener("click", () => void emit(EV_OPEN, { id: i.id }));
        crewMascots.set(i.id, mountMascot(face.querySelector(".m") as HTMLElement, { character: i.character, expression: STATES[i.state].expr, seed: 30 + n }));
      }
      crewMascots.get(i.id)!.setExpression(STATES[i.state].expr);
      face.className = `mate s-${i.state}`;
      face.title = `${i.name}: ${i.chip}\n${i.doing}`;
      crew.appendChild(face);
    });
    crew.querySelectorAll<HTMLElement>(".mate").forEach((p) => {
      if (!seen.has(p.dataset.id!)) {
        crewMascots.get(p.dataset.id!)?.destroy();
        crewMascots.delete(p.dataset.id!);
        p.remove();
      }
    });
  }

  // ----- music -----
  let now: NowPlaying | null = null;
  let notes = 0;
  let musicSig = "";
  const pollMusic = async () => {
    now = prefs.showMusic || prefs.dance ? await invoke<NowPlaying | null>("media_now").catch(() => null) : null;
    const was = dancing;
    dancing = !!now?.playing;
    root.classList.toggle("dancing", dancing && prefs.dance);
    if (was !== dancing) face();
    renderMusic();
  };
  void pollMusic();
  setInterval(() => void pollMusic(), 2000);
  setInterval(() => {
    if (!dancing || !prefs.dance) return;
    const host = root.classList.contains("is-open") ? $(".big-wrap") : $(".side.l .closed-only");
    const n = document.createElement("span");
    n.className = "note";
    n.textContent = ["♪", "♫", "♩"][notes++ % 3];
    n.style.left = `${30 + Math.random() * 40}%`;
    host.appendChild(n);
    setTimeout(() => n.remove(), 1600);
  }, 900);

  function renderMusic() {
    const box = $(".music");
    if (!prefs.showMusic) return;
    const sig = now ? `${now.app}|${now.title}|${now.artist}|${now.playing}|${now.artworkUrl}` : "none";
    if (sig !== musicSig) {
      musicSig = sig;
      box.innerHTML = now
        ? `<div class="cover">${now.artworkUrl ? `<img src="${escHtml(now.artworkUrl)}" alt="">` : `<div class="noart">♪</div>`}${BADGE[now.app] ?? ""}</div>
          <div class="meta"><b>${escHtml(now.title)}</b><span>${escHtml(now.artist)}</span>
            <div class="progress"><i></i></div><div class="times"><span class="pos"></span><span>${mmss(now.duration)}</span></div>
            <div class="controls">
              <button data-media="previous" title="Předchozí"><svg viewBox="0 0 24 24"><path d="M11 6 4 12l7 6zM20 6l-7 6 7 6z"/></svg></button>
              <button data-media="playpause" class="pp" title="${now.playing ? "Pozastavit" : "Přehrát"}">${now.playing ? `<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>` : `<svg viewBox="0 0 24 24"><path d="M7 4.5v15L19.5 12z"/></svg>`}</button>
              <button data-media="next" title="Další"><svg viewBox="0 0 24 24"><path d="m13 6 7 6-7 6zM4 6l7 6-7 6z"/></svg></button>
            </div></div>`
        : `<div class="cover"><div class="noart">♪</div></div><div class="meta"><b>Nic nehraje</b><span>Pusť něco ve Spotify nebo v Hudbě.</span></div>`;
      box.querySelectorAll<HTMLElement>("[data-media]").forEach((b) =>
        b.addEventListener("click", async () => {
          if (!now) return;
          await invoke("media_control", { app: now.app, action: b.dataset.media }).catch(() => {});
          setTimeout(() => void pollMusic(), 350);
        }),
      );
    }
    if (now) {
      const bar = box.querySelector<HTMLElement>(".progress i");
      if (bar) bar.style.width = `${now.duration ? Math.min(100, (now.position / now.duration) * 100) : 0}%`;
      const pos = box.querySelector<HTMLElement>(".pos");
      if (pos) pos.textContent = mmss(now.position);
    }
  }

  // ----- calendar: a strip of days and what the chosen one holds -----
  let chosen = midnight(Date.now());
  // The day the strip was drawn for: after midnight a chosen "today" moves on to the new today.
  let calToday = chosen;
  async function loadCalendar() {
    const nowDay = midnight(Date.now());
    if (nowDay !== calToday) {
      if (chosen === calToday) chosen = nowDay;
      calToday = nowDay;
    }
    if (!prefs.showCalendar) return;
    const today = midnight(Date.now());
    const d = new Date(chosen);
    ($(".my b") as HTMLElement).textContent = MONTHS[d.getMonth()];
    ($(".my span") as HTMLElement).textContent = String(d.getFullYear());
    $(".week").innerHTML = [-2, -1, 0, 1, 2, 3]
      .map((k) => {
        const day = today + k * DAY;
        const dd = new Date(day);
        return `<button data-day="${day}" class="${day === chosen ? "on" : ""}${day === today ? " today" : ""}"><small>${DAYS[dd.getDay()]}</small><b>${String(dd.getDate()).padStart(2, "0")}</b></button>`;
      })
      .join("");
    const body = $(".cal-body");
    const status = await invoke<string>("calendar_status");
    if (status === "none") {
      body.innerHTML = `<button class="ask">Povolit kalendář</button>`;
      body.querySelector(".ask")!.addEventListener("click", async () => {
        await invoke("calendar_request");
        void loadCalendar();
      });
      return;
    }
    if (status !== "granted") {
      body.innerHTML = `<p class="muted">Kalendář je zakázaný v Nastavení systému → Soukromí → Kalendáře.</p>`;
      return;
    }
    const events = await invoke<CalEvent[]>("calendar_events", { fromMs: chosen, toMs: chosen + DAY }).catch(() => []);
    const t = Date.now();
    body.innerHTML = events.length
      ? `<div class="evs">${events
          .map((e) => {
            const on = e.startMs <= t && e.endMs > t;
            const past = e.endMs <= t;
            return `<div class="ev${on ? " now" : ""}${past ? " past" : ""}"><span class="time">${e.allDay ? "celý den" : hm(e.startMs)}</span><b>${escHtml(e.title)}</b></div>`;
          })
          .join("")}</div>`
      : `<div class="empty">${CAL_EMPTY}<b>Žádné události</b><span>${chosen === today ? "Dneska máš volno." : "Ten den máš volno."}</span></div>`;
  }
  $(".week").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-day]");
    if (!b) return;
    chosen = Number(b.dataset.day);
    void loadCalendar();
  });
  void loadCalendar();
  setInterval(() => void loadCalendar(), 60_000);

  // ----- camera: one more card in the row -----
  let stream: MediaStream | null = null;
  const mirror = $(".mirror");
  $("[data-act=mirror]").addEventListener("click", () => (mirror.hidden ? void openMirror() : closeMirror()));
  async function openMirror() {
    mirror.hidden = false;
    $("[data-act=mirror]").classList.add("on");
    const note = mirror.querySelector(".muted") as HTMLElement;
    if (!navigator.mediaDevices?.getUserMedia) {
      note.textContent = "Kamera tady není k dispozici.";
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 640 }, audio: false });
      (mirror.querySelector("video") as HTMLVideoElement).srcObject = stream;
      note.textContent = "";
    } catch (err) {
      note.textContent = `Kamera nejde zapnout (${(err as Error).name}).`;
    }
  }
  function closeMirror() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    const video = mirror.querySelector("video") as HTMLVideoElement;
    video.srcObject = null;
    mirror.hidden = true;
    $("[data-act=mirror]").classList.remove("on");
  }

  applyPrefs();
}
