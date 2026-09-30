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

export async function startNotch() {
  const g = await invoke<{ notchWidth: number; barHeight: number; hasNotch: boolean }>("notch_geometry");
  const cfg = await invoke<{ sounds?: boolean }>("config_load").catch(() => ({ sounds: true }));
  document.body.innerHTML = `
    <div class="nt">
      <div class="bar">
        <div class="wing l"><div class="m"></div></div>
        <div class="gap"></div>
        <div class="wing r"><span class="st"></span></div>
      </div>
      <div class="open">
        <div class="livebox" hidden><div class="m"></div><div class="t"><b></b><div class="lines"></div></div></div>
        <div class="news" hidden><div class="m"></div><div class="t"><b></b><small></small></div></div>
        <div class="list"></div>
        <button class="more">Otevřít Dispečink</button>
      </div>
    </div>`;
  const root = document.querySelector(".nt") as HTMLElement;
  root.style.setProperty("--bar-h", `${g.barHeight}px`);
  root.style.setProperty("--gap", g.hasNotch ? `${g.notchWidth}px` : "0px");
  root.style.setProperty("--closed-w", g.hasNotch ? `${g.notchWidth + 92}px` : "180px");

  const mascotEl = document.querySelector(".wing.l .m") as HTMLElement;
  let base: ExpressionName = "happy";
  let look: [number, number] = [0, 0];
  let reacting = 0;
  const mascot = mountMascot(mascotEl, { character: { color: "#e6e8ef", eyeColor: "#15161a" }, expression: base, transition: 140, seed: 21 });
  const lookAt = () => {
    if (Date.now() < reacting) return;
    mascot.setExpression({ ...EXPRESSIONS[base], lookX: look[0], lookY: look[1] * 0.8, wander: 0 });
  };
  void listen<[number, number]>("notch-look", (e) => {
    look = e.payload;
    lookAt();
  });

  // Poking: it jumps; a few in a row make it happy; too many make it dizzy and cross.
  let pokes: number[] = [];
  mascotEl.addEventListener("click", () => {
    const now = Date.now();
    pokes = pokes.filter((t) => now - t < 2500).concat(now);
    const n = pokes.length;
    mascotEl.classList.remove("hop", "dizzy");
    void mascotEl.offsetWidth;
    mascotEl.classList.add(n >= 5 ? "dizzy" : "hop");
    reacting = now + 1100;
    mascot.setExpression(n >= 5 ? "angry" : n >= 3 ? "happy" : "surprised");
    if (cfg.sounds !== false) sounds.poke(n >= 5 ? 0.6 : 1 + n * 0.08);
    if (n >= 5) pokes = [];
    setTimeout(() => {
      if (Date.now() >= reacting) lookAt();
    }, 1150);
  });

  void listen<boolean>("notch-open", (e) => root.classList.toggle("is-open", e.payload));

  const status = document.querySelector(".st") as HTMLElement;
  const news = document.querySelector(".news") as HTMLElement;
  let newsMascot: MountedMascot | null = null;
  const liveBox = document.querySelector(".livebox") as HTMLElement;
  let liveMascot: MountedMascot | null = null;
  let liveFor: string | null = null;
  let newsId: string | null = null;
  const render = rowList(document.querySelector(".open .list") as HTMLElement);
  subscribe((s) => {
    const w = worst(s);
    base = faceFor(w);
    lookAt();
    const bad = s.items.filter((i) => i.state === "bad").length;
    status.className = `st s-${bad ? "bad" : s.counts.attention ? "you" : s.counts.run ? "run" : "ok"}`;
    status.innerHTML = bad ? `${bad}` : s.counts.attention ? `${s.counts.attention}` : s.counts.run ? `<i></i><i></i><i></i>` : "✓";
    status.title = headline(s);

    const fresh = s.news && Date.now() - s.at < 15_000 ? s.news : null;
    news.hidden = !fresh;
    newsId = fresh?.id ?? null;
    if (fresh) {
      newsMascot?.destroy();
      newsMascot = mountMascot(news.querySelector(".m") as HTMLElement, { character: fresh.character as Partial<MascotCharacter>, expression: STATES[fresh.state].expr, seed: 5 });
      (news.querySelector("b") as HTMLElement).textContent = `${fresh.name}: ${fresh.chip}`;
      (news.querySelector("small") as HTMLElement).textContent = fresh.doing;
    }
    // An agent at work takes the top: what it is doing, step by step, like a terminal.
    const working = s.live?.[0];
    liveBox.hidden = !working;
    if (working) {
      if (liveFor !== working.id) {
        liveMascot?.destroy();
        liveMascot = mountMascot(liveBox.querySelector(".m") as HTMLElement, { character: working.character, expression: "thriving", seed: 8 });
        liveFor = working.id;
      }
      (liveBox.querySelector("b") as HTMLElement).textContent = `${working.name} pracuje`;
      (liveBox.querySelector(".lines") as HTMLElement).innerHTML = working.lines.map((l) => `<code>${escHtml(l)}</code>`).join("");
      news.hidden = true;
    }
    const shown = working ? 2 : fresh ? 3 : 4;
    render([...s.items].filter((i) => i.id !== fresh?.id && i.id !== working?.id).sort(byUrgency).slice(0, shown));
  });
  document.querySelector(".more")!.addEventListener("click", () => void invoke("show_main_window"));
  news.addEventListener("click", () => {
    if (newsId) void emit(EV_OPEN, { id: newsId });
  });
}
