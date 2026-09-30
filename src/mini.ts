// The two small views: the panel under the menu-bar icon, and the mascot in
// the notch. Both only show what the main window broadcasts.

import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { EXPRESSIONS, type ExpressionName, type MascotCharacter } from "./mascot/mascot";
import { mountMascot, type MountedMascot } from "./mascot/svg";
import { EV_OPEN, EV_REFRESH, EV_REQUEST, EV_STATE, type MiniItem, type Snapshot } from "./broadcast";
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
type Tab = "home" | "music" | "calendar" | "mirror";

const ICONS: Record<Tab, string> = {
  home: `<svg viewBox="0 0 24 24"><path d="M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z"/></svg>`,
  music: `<svg viewBox="0 0 24 24"><path d="M9 17.5V6l10-2v11.5"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="16.5" cy="15.5" r="2.5"/></svg>`,
  calendar: `<svg viewBox="0 0 24 24"><rect x="4" y="5.5" width="16" height="14" rx="2.5"/><path d="M4 10h16M8.5 3.5v4M15.5 3.5v4"/></svg>`,
  mirror: `<svg viewBox="0 0 24 24"><rect x="3.5" y="6.5" width="13" height="11" rx="2.5"/><path d="m16.5 10.5 4-2.5v8l-4-2.5z"/></svg>`,
};
const GEAR = `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/></svg>`;
const hm = (ms: number) => new Date(ms).toLocaleTimeString("cs-CZ", { hour: "numeric", minute: "2-digit" });
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export async function startNotch() {
  const g = await invoke<{ notchWidth: number; barHeight: number; hasNotch: boolean }>("notch_geometry");
  const cfg = await invoke<{ sounds?: boolean }>("config_load").catch(() => ({ sounds: true }));
  document.body.innerHTML = `
    <div class="nt">
      <div class="bar">
        <div class="side l">
          <div class="closed-only m tiny"></div>
          <nav class="open-only tabs">${(Object.keys(ICONS) as Tab[]).map((t) => `<button data-tab="${t}" title="${{ home: "Domů", music: "Hudba", calendar: "Kalendář", mirror: "Zrcátko" }[t]}">${ICONS[t]}</button>`).join("")}</nav>
        </div>
        <div class="gap"></div>
        <div class="side r">
          <span class="closed-only st"></span>
          <div class="open-only status"><span class="sum"></span><button data-act="main" title="Otevřít Dispečink">${GEAR}</button></div>
        </div>
      </div>
      <div class="panes">
        <section class="pane" data-pane="home">
          <div class="card hero">
            <div class="big-wrap"><div class="m big"></div><span class="dots" hidden><i></i><i></i><i></i></span></div>
            <div class="steps"></div>
          </div>
          <div class="card pills"></div>
        </section>
        <section class="pane" data-pane="music" hidden><div class="card music"></div></section>
        <section class="pane" data-pane="calendar" hidden><div class="card cal"></div></section>
        <section class="pane" data-pane="mirror" hidden><div class="card mirror"><video autoplay playsinline muted></video><p class="muted"></p></div></section>
      </div>
    </div>`;
  const root = document.querySelector(".nt") as HTMLElement;
  root.style.setProperty("--bar-h", `${g.barHeight}px`);
  root.style.setProperty("--gap", g.hasNotch ? `${g.notchWidth}px` : "0px");
  root.style.setProperty("--closed-w", g.hasNotch ? `${g.notchWidth + 92}px` : "180px");
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;

  // ----- the bot: small in the wing, big in the open notch; both watch the cursor -----
  const botCharacter: Partial<MascotCharacter> = { color: "#e6e8ef", eyeColor: "#15161a" };
  const tiny = mountMascot($(".m.tiny"), { character: botCharacter, expression: "happy", transition: 140, seed: 21 });
  const big = mountMascot($(".m.big"), { character: botCharacter, expression: "happy", transition: 160, seed: 22 });
  let base: ExpressionName = "happy";
  let look: [number, number] = [0, 0];
  let reacting = 0;
  let dancing = false;
  const face = () => {
    if (Date.now() < reacting) return;
    const ex = { ...EXPRESSIONS[dancing && base === "happy" ? "thriving" : base], lookX: look[0], lookY: look[1] * 0.85, wander: 0 };
    tiny.setExpression(ex);
    big.setExpression(ex);
  };
  void listen<[number, number]>("notch-look", (e) => {
    look = e.payload;
    face();
  });

  // Poking either of them: a jump, then happy, then dizzy and cross.
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

  // ----- tabs -----
  let tab: Tab = "home";
  let stream: MediaStream | null = null;
  const showTab = (t: Tab) => {
    tab = t;
    root.querySelectorAll<HTMLElement>("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === t));
    root.querySelectorAll<HTMLElement>("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== t));
    if (t === "mirror") void startMirror();
    else stopMirror();
    if (t === "calendar") void loadCalendar();
    if (t === "music") renderMusic();
  };
  root.querySelector(".tabs")!.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-tab]");
    if (b) showTab(b.dataset.tab as Tab);
  });
  $("[data-act=main]").addEventListener("click", () => void invoke("show_main_window"));
  showTab("home");

  void listen<boolean>("notch-open", (e) => {
    root.classList.toggle("is-open", e.payload);
    if (!e.payload) stopMirror();
    else if (tab === "mirror") void startMirror();
  });

  // ----- home: the working agent's steps, and everyone else as pills -----
  const steps = $(".steps");
  const pills = $(".pills");
  const pillMascots = new Map<string, MountedMascot>();
  subscribe((s) => {
    base = faceFor(worst(s));
    face();
    const bad = s.items.filter((i) => i.state === "bad").length;
    const st = $(".st");
    st.className = `closed-only st s-${dancing ? "music" : bad ? "bad" : s.counts.attention ? "you" : s.counts.run ? "run" : "ok"}`;
    st.innerHTML = dancing ? `<i></i><i></i><i></i><i></i>` : bad ? `${bad}` : s.counts.attention ? `${s.counts.attention}` : s.counts.run ? `<i></i><i></i><i></i>` : "✓";
    $(".sum").textContent = headline(s);

    const working = s.live?.[0];
    ($(".dots") as HTMLElement).hidden = !working;
    const fresh = s.news && Date.now() - s.at < 15_000 ? s.news : null;
    if (working) {
      const lines = working.lines.slice(-3);
      while (lines.length < 3) lines.unshift("");
      steps.innerHTML =
        `<small class="who">${escHtml(working.name)} pracuje</small>` +
        lines.map((l, i) => `<div class="step ${i === lines.length - 1 ? "now" : "past"}">${i === lines.length - 1 ? "›_ " : ""}${escHtml(l)}</div>`).join("");
    } else if (fresh) {
      steps.innerHTML = `<small class="who">${escHtml(fresh.name)}</small><div class="step now">${escHtml(fresh.chip)}</div><div class="step past">${escHtml(fresh.doing)}</div>`;
    } else {
      steps.innerHTML = `<small class="who">Dispečink</small><div class="step now">${escHtml(headline(s))}</div><div class="step past">${s.counts.sleep} spí · ${s.counts.run} pracuje · ${s.counts.off} vypnuto</div>`;
    }

    const others = [...s.items].filter((i) => i.id !== working?.id).sort(byUrgency).slice(0, 4);
    const seen = new Set<string>();
    others.forEach((i, n) => {
      seen.add(i.id);
      let pill = pills.querySelector<HTMLElement>(`[data-id="${CSS.escape(i.id)}"]`);
      if (!pill) {
        pill = document.createElement("button");
        pill.className = "pill";
        pill.dataset.id = i.id;
        pill.innerHTML = `<span class="m"></span><span class="t"></span>`;
        pill.addEventListener("click", () => void emit(EV_OPEN, { id: i.id }));
        pillMascots.set(i.id, mountMascot(pill.querySelector(".m") as HTMLElement, { character: i.character, expression: STATES[i.state].expr, seed: 30 + n }));
      }
      pillMascots.get(i.id)!.setExpression(STATES[i.state].expr);
      const color = (i.character.color as string) ?? "#8b9cff";
      pill.style.setProperty("--c", color);
      (pill.querySelector(".t") as HTMLElement).textContent = `${i.name}: ${i.chip}`;
      pill.title = i.doing;
      pills.appendChild(pill);
    });
    pills.querySelectorAll<HTMLElement>(".pill").forEach((p) => {
      if (!seen.has(p.dataset.id!)) {
        pillMascots.get(p.dataset.id!)?.destroy();
        pillMascots.delete(p.dataset.id!);
        p.remove();
      }
    });
  });

  // ----- music: what plays, the buttons, and a bot that dances along -----
  let now: NowPlaying | null = null;
  let notes = 0;
  const pollMusic = async () => {
    now = await invoke<NowPlaying | null>("media_now").catch(() => null);
    const was = dancing;
    dancing = !!now?.playing;
    root.classList.toggle("dancing", dancing);
    if (was !== dancing) face();
    if (tab === "music") renderMusic();
  };
  void pollMusic();
  setInterval(() => void pollMusic(), 2500);
  // A note floats up from the bot now and then while music plays.
  setInterval(() => {
    if (!dancing) return;
    const host = root.classList.contains("is-open") ? $(".big-wrap") : $(".side.l");
    const n = document.createElement("span");
    n.className = "note";
    n.textContent = ["♪", "♫", "♩"][notes++ % 3];
    n.style.left = `${40 + Math.random() * 30}%`;
    host.appendChild(n);
    setTimeout(() => n.remove(), 1600);
  }, 900);

  function renderMusic() {
    const box = $(".music");
    if (!now) {
      box.innerHTML = `<p class="muted">Nic nehraje. Pusť něco ve Spotify nebo v Hudbě.</p>`;
      return;
    }
    const pct = now.duration ? Math.min(100, (now.position / now.duration) * 100) : 0;
    box.innerHTML = `
      ${now.artworkUrl ? `<img class="art" src="${escHtml(now.artworkUrl)}" alt="">` : `<div class="art none">♪</div>`}
      <div class="meta">
        <small>${escHtml(now.app === "Music" ? "Hudba" : now.app)}${now.playing ? " · hraje" : " · pozastaveno"}</small>
        <b>${escHtml(now.title)}</b><span>${escHtml(now.artist)}</span>
        <div class="progress"><i style="width:${pct.toFixed(1)}%"></i></div>
        <div class="times"><span>${mmss(now.position)}</span><span>${mmss(now.duration)}</span></div>
        <div class="controls">
          <button data-media="previous" title="Předchozí">⏮</button>
          <button data-media="playpause" class="pp" title="${now.playing ? "Pozastavit" : "Přehrát"}">${now.playing ? "⏸" : "▶"}</button>
          <button data-media="next" title="Další">⏭</button>
        </div>
      </div>`;
    box.querySelectorAll<HTMLElement>("[data-media]").forEach((b) =>
      b.addEventListener("click", async () => {
        await invoke("media_control", { app: now!.app, action: b.dataset.media }).catch(() => {});
        setTimeout(() => void pollMusic(), 350);
      }),
    );
  }

  // ----- calendar: today and tomorrow -----
  async function loadCalendar() {
    const box = $(".cal");
    const status = await invoke<string>("calendar_status");
    if (status === "none") {
      box.innerHTML = `<p class="muted">Dispečink zatím nesmí do kalendáře.</p><button class="ask">Povolit kalendář</button>`;
      box.querySelector(".ask")!.addEventListener("click", async () => {
        await invoke("calendar_request");
        void loadCalendar();
      });
      return;
    }
    if (status !== "granted") {
      box.innerHTML = `<p class="muted">Kalendář je zakázaný. Povolíš ho v Nastavení systému → Soukromí a zabezpečení → Kalendáře.</p>`;
      return;
    }
    const events = await invoke<CalEvent[]>("calendar_events").catch(() => []);
    const t = Date.now();
    const today = new Date().toDateString();
    const tomorrow = new Date(t + 86_400_000).toDateString();
    const upcoming = events.filter((e) => e.endMs > t);
    const day = (label: string, list: CalEvent[]) =>
      `<div class="day"><h4>${label}</h4>${
        list.length
          ? list
              .map((e) => {
                const on = e.startMs <= t && e.endMs > t;
                return `<div class="ev${on ? " now" : ""}"><span class="time">${e.allDay ? "celý den" : `${hm(e.startMs)}–${hm(e.endMs)}`}</span><b>${escHtml(e.title)}</b>${e.location ? `<small>${escHtml(e.location)}</small>` : ""}</div>`;
              })
              .join("")
          : `<p class="muted">Nic.</p>`
      }</div>`;
    box.innerHTML =
      day("Dnes", upcoming.filter((e) => new Date(e.startMs).toDateString() === today || (e.startMs < t && e.endMs > t))) +
      day("Zítra", upcoming.filter((e) => new Date(e.startMs).toDateString() === tomorrow));
  }
  setInterval(() => {
    if (tab === "calendar") void loadCalendar();
  }, 60_000);

  // ----- mirror: the camera, only while the tab is open -----
  async function startMirror() {
    const video = $(".mirror video") as HTMLVideoElement;
    const note = $(".mirror .muted");
    if (stream || !root.classList.contains("is-open")) return;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360 }, audio: false });
      video.srcObject = stream;
      note.textContent = "";
    } catch (err) {
      note.textContent = `Kamera nejde zapnout: ${String(err)}`;
    }
  }
  function stopMirror() {
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    const video = root.querySelector<HTMLVideoElement>(".mirror video");
    if (video) video.srcObject = null;
  }
}
