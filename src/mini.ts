// The two small views: the panel under the menu-bar icon, and the mascot in
// the notch. Both only show what the main window broadcasts.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { EXPRESSIONS, type ExpressionName, type MascotCharacter } from "./mascot/mascot";
import { mountMascot, type MountedMascot } from "./mascot/svg";
import { EV_NOTCH_PREFS, EV_OPEN, EV_OPEN_SETTINGS, EV_REFRESH, EV_REQUEST, EV_STATE, type MiniItem, type Snapshot } from "./broadcast";
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
          <span class="closed-only rw"><span class="lstep"></span><span class="st"></span></span>
          <div class="open-only icons">
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
  const LIVE_WING = 190;
  let lastWing = 46;
  subscribe((s) => {
    base = faceFor(worst(s));
    face();
    const bad = s.items.filter((i) => i.state === "bad").length;
    const st = $(".st");
    const music = dancing && prefs.showMusic;
    st.className = `st s-${music ? "music" : bad ? "bad" : s.counts.attention ? "you" : s.counts.run ? "run" : "ok"}`;
    st.innerHTML = music ? `<i></i><i></i><i></i><i></i>` : bad ? `${bad}` : s.counts.attention ? `${s.counts.attention}` : s.counts.run ? `<i></i><i></i><i></i>` : "✓";
    $(".sum").textContent = headline(s);

    const working = s.live?.[0];
    ($(".dots") as HTMLElement).hidden = !working;

    // Live activity: while an agent works, the closed notch widens to show it.
    const wing = working ? LIVE_WING : 46;
    if (wing !== lastWing) {
      lastWing = wing;
      root.style.setProperty("--wing", `${wing}px`);
      root.classList.toggle("live", !!working);
      void invoke("notch_set_wing", { width: wing });
    }
    if (working) {
      $(".lname").textContent = working.name;
      $(".lstep").textContent = working.lines.at(-1) ?? "";
    }
    const fresh = s.news && Date.now() - s.at < 15_000 ? s.news : null;
    if (working) {
      const lines = working.lines.slice(-3);
      while (lines.length < 3) lines.unshift("");
      steps.innerHTML =
        `<small class="who">${escHtml(working.name)} pracuje</small>` +
        lines.map((l, i) => `<div class="step ${i === lines.length - 1 ? "now" : "past"}">${i === lines.length - 1 ? "›_ " : ""}${escHtml(l)}</div>`).join("");
    } else if (fresh) {
      steps.innerHTML = `<small class="who">${escHtml(fresh.name)}</small><div class="step now big-text">${escHtml(fresh.chip)}</div><div class="step past">${escHtml(fresh.doing)}</div>`;
    } else {
      steps.innerHTML = `<small class="who">Dispečink</small><div class="step now big-text">${escHtml(headline(s))}</div><div class="step past">${s.counts.run} pracuje · ${s.counts.sleep} spí</div>`;
    }

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
  });

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
  async function loadCalendar() {
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
