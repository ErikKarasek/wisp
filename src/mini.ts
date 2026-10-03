// The two small views: the panel under the menu-bar icon, and the mascot in
// the notch. Both only show what the main window broadcasts.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { DEFAULT_CHARACTER, EXPRESSIONS, type ExpressionName, type MascotCharacter } from "./mascot/mascot";
import { mountMascot, type MountedMascot } from "./mascot/svg";
import { EV_NOTCH_PREFS, EV_OPEN, EV_OPEN_SETTINGS, EV_REFRESH, EV_REQUEST, EV_STATE, type MiniItem, type Snapshot, windowName, resetText, claudeResetMs, elapsedPercent } from "./broadcast";
import { defaultNotchPrefs, type NotchPrefs, type SavedCharacter } from "./config";
import { SEVERITY, STATES, type State } from "./model";
import { sounds } from "./sounds";
import { awakeHeadline, mountAwake } from "./awake";
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
      <header><div class="m face"></div><div class="ht"><b>Wisp</b><small class="head">Načítám…</small><small class="awake-line"></small></div><span class="mode"></span></header>
      <section class="aw"></section>
      <div class="tiles">
        <div class="tile s-you"><b data-c="attention">–</b><small>čeká na tebe</small></div>
        <div class="tile s-run"><b data-c="run">–</b><small>pracuje</small></div>
        <div class="tile s-sleep"><b data-c="sleep">–</b><small>spí</small></div>
        <div class="tile s-off"><b data-c="off">–</b><small>vypnuto</small></div>
      </div>
      <div class="list"></div>
      <footer>
        <button data-act="open">Otevřít Wisp</button>
        <button data-act="refresh" title="Obnovit">↻</button>
        <button data-act="quit" title="Ukončit Wisp">Ukončit</button>
      </footer>
    </div>`;
  const face = mountMascot(document.querySelector(".face") as HTMLElement, { expression: "happy", seed: 4 });
  const render = rowList(document.querySelector(".list") as HTMLElement);
  mountAwake(document.querySelector(".aw") as HTMLElement, (a) => {
    const h = awakeHeadline(a);
    const line = document.querySelector(".awake-line") as HTMLElement;
    line.textContent = h.line;
    line.classList.toggle("on", h.on);
    const mode = document.querySelector(".mode") as HTMLElement;
    mode.textContent = h.mode;
    mode.classList.toggle("on", h.on);
  });
  // The panel window follows its content (details open and close, rows come and go).
  const pn = document.querySelector(".pn") as HTMLElement;
  // Never taller than the screen under the menu bar: the list at the bottom scrolls instead.
  const fitScreen = () => pn.style.setProperty("--maxh", `${Math.max(320, screen.availHeight - 16)}px`);
  fitScreen();
  window.addEventListener("resize", fitScreen);
  let fitted = 0;
  new ResizeObserver(() => {
    const h = Math.ceil(pn.getBoundingClientRect().height);
    if (h !== fitted) {
      fitted = h;
      void invoke("panel_fit", { height: h });
    }
  }).observe(pn);
  subscribe((s) => {
    face.setExpression(faceFor(worst(s)));
    (document.querySelector(".head") as HTMLElement).textContent = headline(s);
    for (const [k, v] of Object.entries(s.counts)) {
      const el = document.querySelector(`[data-c="${k}"]`);
      if (el) el.textContent = String(v);
    }
    // What needs you or is working first, then the rest.
    render([...s.items].sort(byUrgency).slice(0, 6));
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
const HOME = `<svg viewBox="0 0 24 24"><path d="M4 11l8-6 8 6v8a1 1 0 0 1-1 1h-4v-5h-6v5H5a1 1 0 0 1-1-1z"/></svg>`;
const CHAT = `<svg viewBox="0 0 24 24"><path d="M5 5h14a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H10l-4 3v-3H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z"/></svg>`;
const PLUS = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 8.5v7M8.5 12h7"/></svg>`;
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
/** Claude Code at work, unless the notch settings give it a character: Claude's clay orange. */
const CLAUDE_BOT: Partial<MascotCharacter> = { color: "#d97757", eyeColor: "#2a1610" };
/** The crew shows only who is doing something or wants something, not everyone there is. */
const ACTIVE: State[] = ["run", "you", "new", "bad", "done"];

const TERM = `<svg class="ic" viewBox="0 0 16 16"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 6l2 2-2 2M8.5 10.5h3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
const COPY = `<svg class="ic" viewBox="0 0 16 16"><rect x="5" y="5" width="8.5" height="8.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.2"/><path d="M3 10.5V3.8C3 3.4 3.4 3 3.8 3h6.7" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/></svg>`;

export async function startNotch() {
  const g = await invoke<{ notchWidth: number; barHeight: number; hasNotch: boolean }>("notch_geometry");
  let cfg = await invoke<Cfg>("config_load").catch(() => ({}) as Cfg);
  let prefs: NotchPrefs = { ...defaultNotchPrefs(), ...(cfg.notchPrefs ?? {}) };

  document.body.innerHTML = `
    <div class="nt">
      <div class="bar">
        <div class="side l">
          <div class="closed-only lw"><div class="m tiny"></div><span class="lname"></span></div>
          <div class="open-only tabs">
            <button data-tab="home" class="on" title="Přehled">${HOME}</button>
            <button data-tab="chat" title="Chat s agenty">${CHAT}</button>
            <button data-tab="new" title="Nový úkol pro agenta">${PLUS}</button>
            <span class="sum"></span>
          </div>
        </div>
        <div class="gap"></div>
        <div class="side r">
          <span class="closed-only rw"><span class="lstep"></span><span class="st"></span><span class="faces4"></span><span class="lim" hidden></span></span>
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
        </div>
        <div class="card crewcard"><div class="crew"></div></div>
        <div class="card chatcard" hidden>
          <div class="agents"></div>
          <div class="convo"><div class="msgs"></div>
            <div class="answer"><input type="text" spellcheck="false"><button>Poslat</button></div></div>
        </div>
        <div class="card music"></div>
        <div class="card cal"><div class="cal-head"><div class="my"><b></b><span></span></div><div class="week"></div></div><div class="cal-body"></div></div>
        <div class="card mirror" hidden><video autoplay playsinline muted></video><p class="muted"></p></div>
      </div>
      <i class="countdown"></i>
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
  const claudeLook = () => (prefs.claude ? cfg.characters?.find((c) => c.id === prefs.claude)?.character : undefined) ?? CLAUDE_BOT;
  // The bot takes the look of whoever it is showing right now: the agent at work,
  // the one that failed or asks, Claude in a terminal; your own bot otherwise.
  let shownLook = "";
  const showLook = (c: Partial<MascotCharacter>) => {
    const full = { ...DEFAULT_CHARACTER, ...c };
    const sig = JSON.stringify(full);
    if (sig === shownLook) return;
    shownLook = sig;
    tiny.setCharacter(full);
    big.setCharacter(full);
  };
  const tiny = mountMascot($(".m.tiny"), { character: botLook(), expression: "happy", transition: 180, seed: 21 });
  const big = mountMascot($(".m.big"), { character: botLook(), expression: "happy", transition: 200, seed: 22 });
  let base: ExpressionName = "happy";
  let look: [number, number] = [0, 0];
  let reacting = 0;
  let dancing = false;
  let sleeping = false;
  const face = () => {
    if (Date.now() < reacting) return;
    const name: ExpressionName = sleeping ? "sleepy" : dancing && prefs.dance && base === "happy" ? "thriving" : base;
    const ex = EXPRESSIONS[name];
    // Asleep the eyes are shut; following the cursor would slide the dashes around.
    const shaped = prefs.follow && !sleeping ? { ...ex, lookX: look[0], lookY: look[1] * 0.85, wander: 0 } : ex;
    tiny.setExpression(shaped);
    big.setExpression(shaped);
  };
  const sound = (name: keyof typeof sounds) => {
    if (cfg.sounds !== false) (sounds[name] as () => void)();
  };
  /** A face for a moment, then back to the mood. */
  const react = (ex: ExpressionName, ms: number) => {
    reacting = Date.now() + ms;
    tiny.setExpression(ex);
    big.setExpression(ex);
    setTimeout(face, ms + 50);
  };
  /** Little things rising from the bot: hearts, sparkles, sweat, Zs. */
  const burst = (glyph: string, kind: string, n: number) => {
    const host = root.classList.contains("is-open") ? $(".big-wrap") : $(".side.l .closed-only");
    for (let i = 0; i < n; i += 1) {
      const el = document.createElement("span");
      el.className = `fx ${kind}`;
      el.textContent = glyph;
      el.style.left = `${15 + Math.random() * 70}%`;
      el.style.animationDelay = `${i * 110}ms`;
      host.appendChild(el);
      setTimeout(() => el.remove(), 1900 + i * 110);
    }
  };
  /** Something went well: a wink. */
  const wink = () => {
    sleeping = false;
    react("wink", 1100);
    sound("wink");
  };
  /** A long job finished: a roll over the top and sparkles. */
  const celebrate = () => {
    sleeping = false;
    tiny.roll();
    big.roll();
    react("happy", 1500);
    burst("✦", "spark", 6);
  };
  void listen<[number, number]>("notch-look", (e) => {
    look = e.payload;
    if (prefs.follow) face();
  });

  let pokes: number[] = [];
  for (const el of [$(".m.tiny"), $(".m.big")]) {
    el.addEventListener("click", () => {
      if (carried) {
        carried = false;
        return;
      }
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
      if (n >= 5) {
        pokes = [];
        beatenUntil = Date.now() + 3200;
        renderBeaten();
        setTimeout(() => redraw(), 3300);
      }
      setTimeout(face, 1150);
    });
  }

  // ----- hold the cursor still on the bot and it falls for you -----
  for (const el of [$(".m.tiny"), $(".m.big")]) {
    let timer = 0;
    let at = [0, 0];
    const arm = () => {
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        sleeping = false;
        react("love", 2600);
        burst("♥", "heart", 5);
        sound("love");
      }, 1900);
    };
    el.addEventListener("pointerenter", (e) => {
      at = [e.screenX, e.screenY];
      arm();
    });
    el.addEventListener("pointermove", (e) => {
      if (Math.hypot(e.screenX - at[0], e.screenY - at[1]) > 3) {
        at = [e.screenX, e.screenY];
        arm();
      }
    });
    el.addEventListener("pointerleave", () => clearTimeout(timer));
    el.addEventListener("pointerdown", () => clearTimeout(timer));
  }

  // ----- drag the bot out onto a window: it brings back a picture of it to ask about -----
  let carry: [number, number] | null = null;
  let carried = false;
  for (const el of [$(".m.tiny"), $(".m.big")]) {
    el.addEventListener("pointerdown", (e) => {
      if (e.button === 0) carry = [e.screenX, e.screenY];
    });
  }
  window.addEventListener("pointermove", (e) => {
    if (!carry || carried || !(e.buttons & 1)) return;
    if (Math.hypot(e.screenX - carry[0], e.screenY - carry[1]) > 7) {
      carried = true;
      carry = null;
      root.classList.add("carried");
      sound("wink");
      void invoke("buddy_drag");
    }
  });
  window.addEventListener("pointerup", () => (carry = null));
  const landed = () => {
    root.classList.remove("carried");
    setTimeout(() => (carried = false), 300);
  };
  void listen("buddy-back", () => {
    landed();
    react("surprised", 600);
  });
  void listen<string>("buddy-failed", (e) => {
    landed();
    setMode("note");
    steps.innerHTML = `<small class="who bad">Okno</small><div class="step past wrap">${escHtml(e.payload)}</div>`;
  });
  void listen<{ path: string; app: string; title: string }>("buddy-dropped", (e) => {
    landed();
    wink();
    const { path, app, title } = e.payload;
    showFile(path, `${app}${title ? ` · ${title}` : ""}`, "Vidím to okno. Na co se chceš zeptat? Odpoví Gemini.", "Třeba: co tu je špatně? shrň to");
  });

  // ----- the closing line: the last seconds before the notch folds away -----
  const countdown = $(".countdown");
  let countTimer = 0;
  void listen<number>("notch-countdown", (e) => {
    clearTimeout(countTimer);
    countdown.classList.remove("run");
    countdown.style.transitionDuration = "";
    const ms = e.payload;
    if (ms < 900) return;
    const shown = Math.min(ms, 10_000);
    countTimer = window.setTimeout(() => {
      countdown.style.transitionDuration = `${shown}ms`;
      void countdown.offsetWidth;
      countdown.classList.add("run");
    }, ms - shown);
  });

  // ----- away from the Mac: the closed notch hides, unless something needs you -----
  let away = false;
  void listen<boolean>("notch-away", (e) => {
    away = e.payload;
    redraw();
  });

  /** Replay a one-off body animation (a yawn, a caffeine jitter) on both bots. */
  const play = (cls: string) => {
    for (const el of [$(".m.tiny"), $(".m.big")]) {
      el.classList.remove(cls);
      void el.offsetWidth;
      el.classList.add(cls);
    }
  };
  const yawn = () => {
    reacting = Date.now() + 1500;
    tiny.setExpression("tired");
    big.setExpression("tired");
    play("yawn");
    sound("yawn");
  };

  // ----- nothing happening for a while: a yawn, then sleep -----
  let lastBusy = Date.now();
  const SLEEP_AFTER = 10 * 60_000;
  setInterval(() => {
    if (sleeping || root.classList.contains("is-open") || Date.now() - lastBusy < SLEEP_AFTER || base !== "happy") return;
    yawn();
    setTimeout(() => {
      sleeping = true;
      reacting = 0;
      face();
    }, 1500);
  }, 15_000);
  const wake = () => {
    if (!sleeping) return;
    sleeping = false;
    react("surprised", 700);
  };

  // ----- late at night: yawns, and coffee if you keep working -----
  // From 23:00 to 5:00 the bot yawns every six to twelve minutes. If you are working with Claude
  // then, it has a coffee instead and perks up: a caffeine boost, at most every twenty minutes.
  const night = () => {
    const h = new Date().getHours();
    return h >= 23 || h < 5;
  };
  let nextYawn = 0;
  let lastCoffee = 0;
  setInterval(() => {
    if (!night() || sleeping || Date.now() < reacting) return;
    const now = Date.now();
    if (ccWorking() && now - lastCoffee > 20 * 60_000) {
      lastCoffee = now;
      burst("☕", "coffee", 1);
      setTimeout(() => {
        play("jitter");
        react("thriving", 1600);
        burst("⚡", "spark", 3);
      }, 900);
      return;
    }
    if (now > nextYawn) {
      nextYawn = now + (6 + Math.random() * 6) * 60_000;
      yawn();
      setTimeout(face, 1550);
    }
  }, 20_000);

  // ----- Claude's limit used up: the bot is out of breath -----
  setInterval(() => {
    if (base === "tired" && !sleeping && Date.now() > reacting) burst("💧", "sweat", 1);
  }, 1600);

  // ----- open and close -----
  // When closed, the cards leave the page entirely: a transparent WebKit window
  // otherwise keeps faint ghosts of layers that were only faded out.
  let goneTimer = 0;
  void listen<boolean>("notch-open", (e) => {
    clearTimeout(goneTimer);
    // A new opening starts without a closing line; the native side sends a fresh one.
    clearTimeout(countTimer);
    countdown.classList.remove("run");
    if (e.payload) {
      wake();
      // The four small faces beside the closed notch grow into the crew's pills.
      const from = new Map<string, DOMRect>();
      const ids = ($(".faces4").dataset.ids ?? "").split("|");
      [...$(".faces4").children].forEach((c, n) => ids[n] && from.set(ids[n], c.getBoundingClientRect()));
      panes.classList.remove("gone");
      void panes.offsetWidth; // let the cards exist for a frame before they animate in
      root.classList.add("is-open");
      if (!root.classList.contains("away")) {
        crew.querySelectorAll<HTMLElement>(".pill").forEach((pill, n) => {
          const a = from.get(pill.dataset.id!);
          const m = pill.querySelector<HTMLElement>(".m");
          if (!a || !m || !a.width) return;
          const b = m.getBoundingClientRect();
          if (!b.width) return;
          m.style.transition = "none";
          m.style.transform = `translate(${a.left - b.left}px, ${a.top - b.top}px) scale(${a.width / b.width})`;
          void m.offsetWidth;
          m.style.transition = `transform .52s ${n * 35}ms cubic-bezier(.32, 1.22, .42, 1)`;
          m.style.transform = "";
        });
      }
    } else {
      root.classList.remove("is-open");
      closeMirror();
      goneTimer = window.setTimeout(() => panes.classList.add("gone"), 360);
    }
  });

  // ----- settings -----
  const applyPrefs = () => {
    $(".crewcard").hidden = !prefs.showOthers;
    $(".music").hidden = !prefs.showMusic;
    $(".cal").hidden = !prefs.showCalendar;
    ($("[data-act=mirror]") as HTMLElement).hidden = !prefs.showMirror;
    if (!prefs.showMirror) closeMirror();
    shownLook = "";
    showLook(botLook());
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
  /** The card switches to something else: the new content blurs in (Coucou's transition). */
  const setMode = (mode: string) => {
    if (steps.dataset.mode === mode) return;
    steps.dataset.mode = mode;
    if (mode !== "work") tickerSig = "";
    steps.classList.remove("enter");
    void steps.offsetWidth;
    steps.classList.add("enter");
  };
  // What the working agent does, as lines that slide up as new steps come in;
  // the current one shimmers.
  let tickerSig = "";
  const ROW = 24;
  function renderTicker(name: string, lines: string[]) {
    let roll = steps.querySelector<HTMLElement>(".ticker .roll");
    if (steps.dataset.mode !== "work" || !roll) {
      setMode("work");
      steps.innerHTML = `<small class="who"></small><div class="ticker"><div class="roll"></div></div>`;
      roll = steps.querySelector<HTMLElement>(".ticker .roll")!;
      tickerSig = "";
    }
    (steps.querySelector(".who") as HTMLElement).textContent = `${name} pracuje`;
    const shown = lines.filter(Boolean).slice(-4);
    const sig = shown.join("\n");
    if (sig === tickerSig) return;
    const moved = tickerSig !== "" && tickerSig.split("\n").at(-1) !== shown.at(-1);
    tickerSig = sig;
    roll.innerHTML = shown
      .map((l, i) => {
        const now = i === shown.length - 1;
        return `<div class="step ${now ? "now" : "past"}">${now ? TERM : COPY}<span class="tx">${escHtml(l)}</span></div>`;
      })
      .join("");
    if (moved) {
      roll.style.transition = "none";
      roll.style.transform = `translateY(${ROW}px)`;
      void roll.offsetWidth;
      roll.style.transition = "";
      roll.style.transform = "";
    }
  }
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

  // ----- Claude Code in a terminal: its hooks post to Wisp, which passes them here -----
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
  /** "agent:<id>" from a Paperclip agent's Claude → that agent's name. */
  const nameOf = (project: string) => (project.startsWith("agent:") ? lastSnap?.items.find((i) => i.id === project)?.name ?? "Agent" : project);
  void listen<CcEvent>("cc-event", (e) => {
    const { session, kind, text } = e.payload;
    const project = nameOf(e.payload.project);
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
      const wasBusy = cur.busy;
      cur.busy = false;
      ccDone = { project, text, at: now };
      if (long) {
        if (cfg.sounds !== false) sounds.done();
        void invoke("notch_peek", { millis: 5000 });
        celebrate();
      } else if (wasBusy) wink();
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
    setMode(`perm:${p.id}`);
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
        if (b.dataset.a === "allow" || b.dataset.a === "always") wink();
        perms = perms.filter((x) => x.id !== p.id);
        permShown = null;
        redraw();
      }),
    );
  }

  // ----- a file dropped on the notch, and a question about it (Gemini answers) -----
  let fileAsk: { path: string; name: string } | null = null;
  // Outside Tauri (a browser copy) there is no webview; the rest of the notch must still work.
  try {
    void getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") root.classList.add("dropping");
      else if (p.type === "leave") root.classList.remove("dropping");
      else if (p.type === "drop") {
        root.classList.remove("dropping");
        if (p.paths[0]) showFile(p.paths[0]);
      }
    });
  } catch {
    /* no drag and drop here */
  }
  function showFile(
    path: string,
    name = path.split("/").pop() ?? path,
    hint = "Na co se chceš zeptat? Odpoví Gemini z tvého AI Pro.",
    example = "Třeba: kolik to dělá celkem?",
  ) {
    fileAsk = { path, name };
    quickAsk = false;
    snipOn = false;
    root.classList.add("asking");
    permShown = null;
    setMode(`file:${path}`);
    steps.innerHTML = `<small class="who">${escHtml(name)}<button class="x" title="Zavřít">✕</button></small>
      <div class="step past wrap reply">${escHtml(hint)}</div>
      <div class="answer"><input type="text" placeholder="${escHtml(example)}" spellcheck="false"><button>Zeptat se</button></div>`;
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
      reply.innerHTML = `<div class="run-bar"><i></i></div><small>Gemini čte ${escHtml(name)}…</small>`;
      try {
        const text = await invoke<string>("ask_file", { path, question: q });
        reply.textContent = text.replace(/\*\*|__|`/g, "");
        wink();
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
    snipOn = false;
    permShown = null;
    root.classList.add("asking");
    setMode("quick");
    let clip = e.payload.trim();
    const preview = clip.replace(/\s+/g, " ").slice(0, 90);
    steps.innerHTML = `<small class="who">Rychlá otázka · Gemini<button class="x" title="Zavřít (Esc)">✕</button></small>
      ${clip ? `<div class="step past clip"><span>Zkopírováno: „${escHtml(preview)}${clip.length > 90 ? "…" : ""}“</span><button class="drop-clip">nepoužít</button></div>` : ""}
      <div class="step past wrap reply"></div>
      <div class="answer"><input type="text" placeholder="${clip ? "Třeba: přelož, vysvětli, shrň" : "Na co se chceš zeptat?"}" spellcheck="false"><button>Zeptat</button></div>`;
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
        wink();
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

  // ----- ⌃⌥E: an error marked on the screen. Gemini reads it, Claude fixes it on a button -----
  type Reading = { error: boolean; summary: string; text: string; project: string | null; file: string | null; cause: string };
  type Fixed = { id: string; summary: string; files: string[] };
  let snipOn = false;
  /** A fix waiting for Nechat or Vrátit; closing the card keeps it. */
  let snipPending: string | null = null;
  const closeSnip = () => {
    if (snipPending) void invoke("snip_keep", { id: snipPending });
    snipPending = null;
    snipOn = false;
    redraw();
  };
  const snipCard = (head: string, body: string) => {
    snipOn = true;
    fileAsk = null;
    quickAsk = false;
    permShown = null;
    root.classList.add("asking");
    setMode("snip");
    steps.innerHTML = `<small class="who">${escHtml(head)}<button class="x" title="Zavřít (Esc)">✕</button></small>${body}`;
    steps.querySelector(".x")!.addEventListener("click", closeSnip);
  };
  const clean = (t: string) => t.replace(/\*\*|__|`/g, "");
  void listen<{ path: string; app: string; title: string }>("snip", async (e) => {
    if (snipPending) void invoke("snip_keep", { id: snipPending });
    snipPending = null;
    snipCard("Výřez · Gemini", `<div class="step past wrap"><div class="run-bar"><i></i></div><small>Gemini čte, co jsi označil…</small></div>`);
    let r: Reading;
    try {
      r = await invoke<Reading>("snip_read", e.payload);
    } catch (err) {
      snipCard("Výřez", `<div class="step past wrap">${escHtml(String(err))}</div>`);
      return;
    }
    if (!snipOn) return;
    wink();
    if (!r.error) {
      snipCard("Výřez · Gemini", `<div class="step past wrap">${escHtml(clean(r.summary))}</div>${r.cause ? `<div class="step past wrap"><small>${escHtml(clean(r.cause))}</small></div>` : ""}`);
      return;
    }
    const where = r.project ? `${r.project}${r.file ? ` · ${r.file}` : ""}` : "projekt jsem nepoznal";
    snipCard(
      `Chyba · ${where}`,
      `<div class="step past wrap">${escHtml(clean(r.summary))}</div>
      <div class="step past wrap"><small>${escHtml(clean(r.cause))}</small></div>
      <div class="perm">
        <button data-a="copy">Kopírovat chybu</button>
        ${r.project ? `<button data-a="fix" class="go">Opravit s Claudem</button>` : ""}
      </div>`,
    );
    steps.querySelector<HTMLButtonElement>('[data-a="copy"]')!.addEventListener("click", async (ev) => {
      await navigator.clipboard.writeText(r.text || r.summary).catch(() => {});
      (ev.target as HTMLButtonElement).textContent = "Zkopírováno";
    });
    steps.querySelector<HTMLButtonElement>('[data-a="fix"]')?.addEventListener("click", () => void runFix(r));
    void invoke("notch_peek", { millis: 60_000 });
  });
  async function runFix(r: Reading) {
    const project = r.project!;
    snipCard(`Claude · ${project}`, `<div class="step past wrap"><div class="run-bar"><i></i></div><small>Claude hledá příčinu a opravuje. Může to pár minut trvat, klidně dělej něco jiného.</small></div>`);
    let f: Fixed;
    try {
      f = await invoke<Fixed>("snip_fix", { project, text: r.text || r.summary, cause: r.cause, file: r.file });
    } catch (err) {
      snipCard(`Claude · ${project}`, `<div class="step past wrap">${escHtml(String(err))}</div>`);
      return;
    }
    wink();
    snipPending = f.files.length ? f.id : null;
    const list = f.files.slice(0, 5).map(escHtml).join(", ") + (f.files.length > 5 ? ` a ${f.files.length - 5} dalších` : "");
    snipCard(
      `Claude · ${project}`,
      `<div class="step past wrap reply">${escHtml(clean(f.summary || "Hotovo."))}</div>
      ${f.files.length ? `<div class="step past wrap"><small>Změněno: ${list}. Necommitnuto.</small></div>
      <div class="perm"><button data-a="undo">Vrátit</button><button data-a="keep" class="go">Nechat</button></div>` : `<div class="step past wrap"><small>Nic se nezměnilo.</small></div>`}`,
    );
    steps.querySelector('[data-a="keep"]')?.addEventListener("click", closeSnip);
    steps.querySelector<HTMLButtonElement>('[data-a="undo"]')?.addEventListener("click", async () => {
      const id = snipPending;
      snipPending = null;
      if (!id) return;
      try {
        await invoke("snip_undo", { id });
        snipCard(`Claude · ${project}`, `<div class="step past wrap">Vráceno, soubory jsou jako předtím.</div>`);
      } catch (err) {
        snipCard(`Claude · ${project}`, `<div class="step past wrap">${escHtml(String(err))}</div>`);
      }
      void invoke("notch_peek", { millis: 6000 });
    });
  }
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && snipOn) closeSnip();
  });
  // ----- back at the Mac after a break: where Erik stopped (resume.rs) -----
  type Resume = {
    project: string | null;
    title: string | null;
    summary: string;
    next: string;
    branch: string | null;
    dirty: number;
    lastCommit: string | null;
    agoMin: number;
    night: { project: string; task: string; pr: string | null; ok: boolean }[];
  };
  void listen<Resume>("resume", (e) => {
    if (snipOn || quickAsk || fileAsk) return;
    const r = e.payload;
    const meta = r.branch
      ? `větev ${r.branch}${r.dirty ? ` · necommitnuto ${r.dirty}` : ""}${r.lastCommit ? ` · poslední commit „${r.lastCommit}“` : ""}`
      : "";
    const night = r.night
      .map((n) => `<div class="step past wrap"><small>🌙 ${escHtml(n.project)} – ${escHtml(n.task)}${n.pr ? ` · <a href="${escHtml(n.pr)}" class="pr">PR</a>` : n.ok ? "" : " (nedopadlo)"}</small></div>`)
      .join("");
    snipCard(
      `Vítej zpátky${r.project ? ` · ${r.project}` : ""}`,
      `${r.summary ? `<div class="step past wrap">${escHtml(clean(r.summary))}</div>` : ""}
      ${r.next ? `<div class="step past wrap"><small>Dál: ${escHtml(clean(r.next))}</small></div>` : ""}
      ${meta ? `<div class="step past wrap"><small>${escHtml(meta)}</small></div>` : ""}
      ${night}
      <div class="perm">
        ${r.project ? `<button data-a="code">Otevřít projekt</button>` : ""}
        <button data-a="claude">Claude</button>
        <button data-a="ok" class="go">Jasně</button>
      </div>`,
    );
    wink();
    const open = (how: string) => void invoke("resume_open", { project: r.project, how }).catch(() => {});
    steps.querySelector('[data-a="code"]')?.addEventListener("click", () => {
      open("code");
      closeSnip();
    });
    steps.querySelector('[data-a="claude"]')!.addEventListener("click", () => {
      open("claude");
      closeSnip();
    });
    steps.querySelector('[data-a="ok"]')!.addEventListener("click", closeSnip);
    steps.querySelectorAll<HTMLAnchorElement>("a.pr").forEach((a) =>
      a.addEventListener("click", (ev) => {
        ev.preventDefault();
        void invoke("plugin:opener|open_url", { url: a.href }).catch(() => {});
      }),
    );
  });


  // ----- tabs: the overview, a chat with the agents, a new task -----
  let tab: "home" | "chat" | "new" = "home";
  let chatAgent: string | null = null;
  const chatcard = $(".chatcard");
  const homeCards = () => [...panes.querySelectorAll<HTMLElement>(".card:not(.chatcard)")];
  function setTab(next: typeof tab) {
    tab = next;
    root.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    const chat = tab !== "home";
    chatcard.hidden = !chat;
    homeCards().forEach((c) => c.classList.toggle("tabbed-out", chat));
    for (const c of chat ? [chatcard] : homeCards()) {
      c.classList.remove("enter");
      void c.offsetWidth;
      c.classList.add("enter");
    }
    if (chat) void renderChat();
  }
  root.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab as typeof tab)));
  // While the chat is open, the agent's answer shows up on its own.
  setInterval(() => {
    if (tab === "chat" && root.classList.contains("is-open") && document.activeElement !== chatcard.querySelector("input")) void renderChat();
  }, 6000);
  const chatMascots: MountedMascot[] = [];
  void listen<boolean>("notch-open", (e) => {
    if (!e.payload) setTab("home");
  });

  type Obj = Record<string, any>;
  const listOf = (v: Obj[] | { items: Obj[] }) => (Array.isArray(v) ? v : v.items ?? []);
  async function renderChat() {
    const s = lastSnap;
    if (!s) return;
    const agents = s.items.filter((i) => i.id.startsWith("agent:") && i.state !== "off");
    if (!chatAgent || !agents.some((a) => a.id === chatAgent)) chatAgent = agents[0]?.id ?? null;
    const box = chatcard.querySelector(".agents") as HTMLElement;
    box.innerHTML = agents
      .map((a) => `<button class="pill${a.id === chatAgent ? " on" : ""} s-${a.state}" data-agent="${escHtml(a.id)}" style="--c:${escHtml((a.character as { color?: string }).color ?? "#8b9cff")}"><span class="m"></span><b>${escHtml(a.name)}</b></button>`)
      .join("");
    chatMascots.splice(0).forEach((m) => m.destroy());
    box.querySelectorAll<HTMLElement>("[data-agent]").forEach((b, n) => {
      const a = agents[n];
      chatMascots.push(mountMascot(b.querySelector(".m") as HTMLElement, { character: a.character, expression: STATES[a.state].expr, seed: 70 + n }));
      b.addEventListener("click", () => {
        chatAgent = a.id;
        void renderChat();
      });
    });
    const agent = agents.find((a) => a.id === chatAgent);
    const msgs = chatcard.querySelector(".msgs") as HTMLElement;
    const input = chatcard.querySelector("input") as HTMLInputElement;
    if (!agent) {
      msgs.innerHTML = `<p class="muted">Žádní agenti.</p>`;
      return;
    }
    const agentId = agent.id.slice(6);
    input.placeholder = tab === "new" ? `Nový úkol pro ${agent.name}…` : `Napiš ${agent.name}…`;
    let thread: Obj | null = null;
    if (tab === "chat") {
      try {
        const full = await invoke<Obj>("paperclip_request", { method: "GET", path: `/agents/${agentId}`, body: null });
        const issues = listOf(await invoke<Obj[] | { items: Obj[] }>("paperclip_request", { method: "GET", path: `/companies/${full.companyId}/issues`, body: null }));
        thread = issues.filter((i) => i.assigneeAgentId === agentId).sort((x, y) => y.updatedAt.localeCompare(x.updatedAt))[0] ?? null;
        if (thread) {
          const comments = listOf(await invoke<Obj[] | { items: Obj[] }>("paperclip_request", { method: "GET", path: `/issues/${thread.id}/comments`, body: null }))
            .sort((x, y) => x.createdAt.localeCompare(y.createdAt))
            .slice(-4);
          msgs.innerHTML =
            `<small class="who">${escHtml(thread.identifier)} · ${escHtml(thread.title)}</small>` +
            comments.map((m) => `<div class="bub ${m.authorAgentId ? "them" : "me"}">${escHtml(String(m.body ?? "").replace(/[*`#>]/g, "").slice(0, 280))}</div>`).join("");
          msgs.scrollTop = msgs.scrollHeight;
        } else {
          msgs.innerHTML = `<p class="muted">Zatím spolu nic neřešíte. Napiš úkol a ${escHtml(agent.name)} se do něj pustí.</p>`;
        }
      } catch {
        msgs.innerHTML = `<p class="muted">Paperclip neodpovídá.</p>`;
      }
    } else {
      msgs.innerHTML = `<p class="muted">Napiš, co má ${escHtml(agent.name)} udělat. První věta bude název úkolu; hned se probudí a pustí se do toho.</p>`;
    }
    const go = chatcard.querySelector(".answer button") as HTMLButtonElement;
    const send = async () => {
      const text = input.value.trim();
      if (!text || go.disabled) return;
      go.disabled = true;
      // The main window knows Paperclip best; it handles the phone's commands the same way.
      if (thread && tab === "chat") await emit("relay-cmd", { kind: "comment", issueId: thread.id, text });
      else await emit("relay-cmd", { kind: "task", agentId, text });
      input.value = "";
      go.disabled = false;
      msgs.insertAdjacentHTML("beforeend", `<div class="bub me">${escHtml(text)}</div>`);
      msgs.scrollTop = msgs.scrollHeight;
      if (tab === "new") setTab("chat");
      setTimeout(() => void renderChat(), 4000);
    };
    go.onclick = () => void send();
    input.onkeydown = (e) => {
      if (e.key === "Enter") void send();
    };
    input.focus();
  }

  // ----- a failure: a red card with a retry, like Grok Bot's "couldn't finish" -----
  function renderFailure(bad: MiniItem) {
    if (steps.dataset.fail === bad.id) return;
    steps.dataset.fail = bad.id;
    setMode(`fail:${bad.id}`);
    steps.innerHTML = `<small class="who bad">${escHtml(bad.name)} selhal</small>
      <div class="step past wrap failtext">${escHtml(bad.doing)}</div>
      <div class="perm"><button class="go retry">Zkusit znovu</button><button data-open>Otevřít</button></div>`;
    steps.querySelector(".retry")!.addEventListener("click", () => {
      if (bad.id.startsWith("job:")) void emit("relay-cmd", { kind: "job", label: bad.id.slice(4), action: "run" });
      else if (bad.id.startsWith("agent:")) void emit("relay-cmd", { kind: "agent", agentId: bad.id.slice(6), action: "agentInvoke" });
      steps.innerHTML = `<small class="who">${escHtml(bad.name)}</small><div class="step now big-text">Zkouším to znovu…</div>`;
      steps.dataset.fail = "";
    });
    steps.querySelector("[data-open]")!.addEventListener("click", () => void emit(EV_OPEN, { id: bad.id }));
  }

  // ----- poked too hard: the bot takes a beating and needs a moment -----
  let beatenUntil = 0;
  function renderBeaten() {
    setMode("beaten");
    steps.innerHTML = `<div class="beaten"><span class="spin"></span><div><b>Dostal jsem nakládačku.</b><small>Vzpamatovávám se…</small></div></div>`;
  }

  let lastSnap: Snapshot | null = null;
  /** Each item's state at the last draw, to notice an agent finishing. */
  const lastState = new Map<string, State>();
  const redraw = () => {
    if (lastSnap) draw(lastSnap);
  };
  const draw = (s: Snapshot) => {
    lastSnap = s;
    // An agent that was working and has finished (not failed) gets a roll and sparkles.
    for (const i of s.items) {
      const was = lastState.get(i.id);
      if (i.id.startsWith("agent:") && was === "run" && i.state !== "run" && i.state !== "bad" && i.state !== "off") celebrate();
      lastState.set(i.id, i.state);
    }
    root.classList.toggle("focus", !!s.focus);

    root.classList.toggle("err", s.items.some((i) => i.state === "bad"));
    // Claude's limit used up (session or week): out of breath, unless something failed.
    const spent = Math.max(s.usage?.session?.percent ?? 0, s.usage?.week?.percent ?? 0) >= 95;
    base = s.focus && worst(s) !== "bad" ? "thriving" : spent && worst(s) !== "bad" ? "tired" : faceFor(worst(s));
    const busy = s.counts.run > 0 || s.counts.attention > 0 || s.items.some((i) => i.state === "bad") || !!ccWorking() || perms.length > 0;
    if (busy) {
      lastBusy = Date.now();
      wake();
    }
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
    const extra = (lim.hidden ? 0 : (limits.match(/class="li /g)?.length ?? 0) * 21 + (limits.match(/<b>/g)?.length ?? 0) * 17 + 4) + 26;
    // Only Paperclip agents widen the notch with their step; Claude Code in a
    // terminal shows its dots here and the steps in the open notch.
    const wide = !!s.live?.[0];
    // Away from the Mac, only what needs you keeps the notch out.
    const hide = away && !perms.length && !s.counts.attention && !s.items.some((i) => i.state === "bad");
    root.classList.toggle("away", hide);
    const wing = hide ? 0 : (wide ? LIVE_WING : 46) + extra;
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

    const failedItem = !working ? s.items.find((i) => i.state === "bad") : undefined;
    const askingItem = !working ? s.items.find((i) => i.ask) : undefined;
    const who = perms.length ? claudeLook() : working ? (working.id.startsWith("cc:") ? claudeLook() : working.character) : failedItem?.character ?? askingItem?.character;
    showLook(who && Object.keys(who).length ? who : botLook());

    // Claude Code asking for permission comes first, then a dropped file.
    // An agent's question gets the whole card too, like a quick question.
    const agentAsks = !working && s.items.some((i) => i.ask);
    root.classList.toggle("asking", perms.length > 0 || !!fileAsk || quickAsk || snipOn || agentAsks);
    if (perms.length) {
      renderPerm();
      return renderCrew(s, working);
    }
    permShown = null;
    if (fileAsk || quickAsk || snipOn) return renderCrew(s, working);
    if (Date.now() < beatenUntil) return renderCrew(s, working);
    const failed = !working ? s.items.find((i) => i.state === "bad") : undefined;
    if (failed) {
      renderFailure(failed);
      return renderCrew(s, working);
    }
    steps.dataset.fail = "";
    const doneCc = !working && ccDone && Date.now() - ccDone.at < 15_000 ? ccDone : null;

    const asking = !working && !(fresh && fresh.id === "morning") ? s.items.find((i) => i.ask) : undefined;
    if (asking?.ask) {
      if (askFor !== asking.ask.issueId) showAsk(asking);
      return renderCrew(s, working);
    }
    askFor = null;
    if (working) {
      renderTicker(working.name, working.lines);
    } else if (doneCc) {
      setMode(`done:${doneCc.at}`);
      steps.innerHTML = `<small class="who">${escHtml(doneCc.project)} · Claude</small><div class="step now big-text">Hotovo</div><div class="step past wrap">${escHtml(doneCc.text)}</div>`;
    } else if (fresh) {
      setMode(`news:${fresh.id}`);
      steps.innerHTML = `<small class="who">${escHtml(fresh.name)}</small><div class="step now big-text">${escHtml(fresh.chip)}</div><div class="step past${fresh.id === "morning" ? " wrap" : ""}">${escHtml(fresh.doing)}</div>`;
    } else {
      setMode("idle");
      steps.innerHTML = `<small class="who">Wisp</small><div class="step now big-text">${escHtml(headline(s))}</div><div class="step past">${s.counts.run} pracuje · ${s.counts.sleep} spí</div>`;
    }

    renderCrew(s, working);
  };
  subscribe(draw);

  // An agent that waits on you: its question, and a box to answer it right here.
  let askFor: string | null = null;
  async function showAsk(item: MiniItem) {
    const ask = item.ask!;
    askFor = ask.issueId;
    setMode(`ask:${ask.issueId}`);
    steps.innerHTML = `<small class="who">${escHtml(item.name)} se ptá</small><div class="step now big-text small">${escHtml(ask.title)}</div>
      <div class="step past wrap q">…</div>
      <div class="answer"><input type="text" placeholder="Odpověz ${escHtml(item.name)}…" spellcheck="false"><button>Poslat</button></div>`;
    const comments = await invoke<Record<string, any>[] | { items: Record<string, any>[] }>("paperclip_request", { method: "GET", path: `/issues/${ask.issueId}/comments`, body: null }).catch(() => []);
    const list = Array.isArray(comments) ? comments : comments.items;
    const last = [...list].reverse().find((c) => c.authorAgentId);
    const q = steps.querySelector(".q");
    if (q) q.textContent = (last?.body ?? "").replace(/[*`#>]/g, "").replace(/\s+/g, " ").slice(0, 240) || "Otevři úkol ve Wispu.";
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

  // The crew: four agents as coloured pills with what they do (agents first, then the busiest others).
  const crewStatus = (i: MiniItem) =>
    i.state === "run" ? i.doing : i.state === "you" ? "Čeká na tebe" : i.state === "bad" ? "Selhal" : i.state === "done" ? "Hotovo" : i.state === "new" ? "Něco našel" : i.name;
  // Four: who is busy right now first, then whoever did something most recently.
  function crewPick(s: Snapshot, working?: { id: string }) {
    const busy = s.items.filter((i) => ACTIVE.includes(i.state) && i.id !== working?.id);
    const agents = busy.filter((i) => i.id.startsWith("agent:"));
    const rest = busy.filter((i) => !i.id.startsWith("agent:"));
    const taken = new Set([...busy.map((i) => i.id), working?.id]);
    const recent = (s.recent ?? []).map((id) => s.items.find((i) => i.id === id)).filter((i): i is MiniItem => !!i && !taken.has(i.id));
    const fill = s.items.filter((i) => i.id.startsWith("agent:") && i.state !== "off" && !taken.has(i.id));
    const out = [...agents.sort(byUrgency), ...rest.sort(byUrgency)];
    for (const i of [...recent, ...fill]) if (!out.some((o) => o.id === i.id)) out.push(i);
    return out.slice(0, 4);
  }
  function renderCrew(s: Snapshot, working: Snapshot["live"][number] | undefined) {
    const four = crewPick(s, working);
    const seen = new Set<string>();
    four.forEach((i, n) => {
      seen.add(i.id);
      let pill = crew.querySelector<HTMLElement>(`[data-id="${CSS.escape(i.id)}"]`);
      if (!pill) {
        pill = document.createElement("button");
        pill.dataset.id = i.id;
        pill.innerHTML = `<span class="m"></span><span class="nm"><b></b><small></small></span>`;
        pill.addEventListener("click", () => void emit(EV_OPEN, { id: i.id }));
        crewMascots.set(i.id, mountMascot(pill.querySelector(".m") as HTMLElement, { character: i.character, expression: STATES[i.state].expr, seed: 30 + n }));
      }
      crewMascots.get(i.id)!.setExpression(STATES[i.state].expr);
      pill.className = `pill s-${i.state}`;
      pill.style.setProperty("--c", (i.character as { color?: string }).color ?? "#8b9cff");
      // Only busy ones are here now, so each says who it is and what's up.
      (pill.querySelector("b") as HTMLElement).textContent = i.name;
      (pill.querySelector("small") as HTMLElement).textContent = crewStatus(i) === i.name ? i.chip : crewStatus(i);
      pill.title = `${i.name}: ${i.chip}\n${i.doing}`;
      crew.appendChild(pill);
    });
    crew.querySelectorAll<HTMLElement>(".pill").forEach((p) => {
      if (!seen.has(p.dataset.id!)) {
        crewMascots.get(p.dataset.id!)?.destroy();
        crewMascots.delete(p.dataset.id!);
        p.remove();
      }
    });
    // Nobody else busy: the card steps aside and the others get its room.
    $(".crewcard").classList.toggle("idle", four.length === 0);
    renderFaces(four);
  }

  // Closed notch: the same four as tiny faces in a 2×2, next to the limits.
  const faceMascots = new Map<string, MountedMascot>();
  function renderFaces(four: MiniItem[]) {
    const box = $(".faces4");
    const ids = four.map((i) => i.id).join("|");
    if (box.dataset.ids !== ids) {
      faceMascots.forEach((m) => m.destroy());
      faceMascots.clear();
      box.innerHTML = four.map(() => `<span></span>`).join("");
      four.forEach((i, n) => faceMascots.set(i.id, mountMascot(box.children[n] as HTMLElement, { character: i.character, expression: STATES[i.state].expr, seed: 50 + n })));
      box.dataset.ids = ids;
    }
    four.forEach((i) => faceMascots.get(i.id)?.setExpression(STATES[i.state].expr));
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
    root.classList.add("mirroring");
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
    root.classList.remove("mirroring");
    $("[data-act=mirror]").classList.remove("on");
  }

  applyPrefs();
}

// ---------- the bot carried out of the notch ----------

export async function startBuddy() {
  document.body.innerHTML = `<div class="bd"><div class="m"></div></div>`;
  const look = async () => {
    const cfg = await invoke<Cfg>("config_load").catch(() => ({}) as Cfg);
    const prefs: NotchPrefs = { ...defaultNotchPrefs(), ...(cfg.notchPrefs ?? {}) };
    const saved = prefs.bot ? cfg.characters?.find((c) => c.id === prefs.bot) : null;
    return saved ? saved.character : WHITE_BOT;
  };
  const m = mountMascot(document.querySelector(".bd .m") as HTMLElement, { character: await look(), expression: "surprised", transition: 160, seed: 9 });
  void listen("buddy-carry", async () => {
    m.setCharacter(await look());
    m.setExpression("surprised");
    setTimeout(() => m.setExpression("thriving"), 500);
  });
}
