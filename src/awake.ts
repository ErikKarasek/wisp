// The "keep awake" part of the menu-bar panel, LidRun-style: what the Mac is
// doing, switches for automatic / by hand / charger only / timer / closed lid,
// and who else keeps it awake. awake.rs does the work; this only shows and asks.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export type AwakePrefs = {
  auto: boolean;
  manual: boolean;
  chargingOnly: boolean;
  display: boolean;
  lid: boolean;
  lidUntilDone: boolean;
  untilMs: number | null;
  batteryStop: number;
  sleepAfterMin: number;
};

export type Awake = {
  prefs: AwakePrefs;
  holding: boolean;
  lidActive: boolean;
  lidReady: boolean;
  why: string;
  working: string[];
  battery: number | null;
  onAc: boolean;
  charging: boolean;
  lidClosed: boolean;
  thermal: number;
  cpu: number;
  idleSecs: number;
  others: { app: string; what: string }[];
  weekMinutes: number;
  error: string | null;
};

const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const svg = (d: string) => `<svg viewBox="0 0 24 24">${d}</svg>`;
const ICON = {
  auto: svg(`<path d="M12 3l1.8 4.6L18.5 9l-4.7 1.6L12 15l-1.8-4.4L5.5 9l4.7-1.4z"/><path d="M18 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>`),
  eye: svg(`<path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>`),
  bolt: svg(`<path d="M13 3L5 13.5h6L10 21l8-10.5h-6z"/>`),
  timer: svg(`<circle cx="12" cy="13" r="7.5"/><path d="M12 9v4l2.5 2M9.5 2.5h5"/>`),
  lid: svg(`<rect x="4" y="5" width="16" height="10.5" rx="1.5"/><path d="M2 19h20"/>`),
  display: svg(`<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>`),
  moon: svg(`<path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z"/>`),
  list: svg(`<path d="M8 6.5h12M8 12h12M8 17.5h12"/><circle cx="4" cy="6.5" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="17.5" r="1"/>`),
  gear: svg(`<circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/>`),
  bat: svg(`<rect x="2.5" y="7" width="17" height="10" rx="2.5"/><path d="M21.5 10.5v3"/>`),
  heat: svg(`<path d="M10 4.5a2 2 0 0 1 4 0v9.2a4 4 0 1 1-4 0z"/>`),
  cpu: svg(`<rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9.5 2.5v3.5M14.5 2.5v3.5M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"/>`),
};
const HEAT = ["v pohodě", "teplý", "horký", "přehřátý"];
const TIMERS: [number, string][] = [[0, "bez časovače"], [30, "30 min"], [60, "1 h"], [120, "2 h"], [240, "4 h"], [480, "8 h"]];

const left = (ms: number) => {
  const min = Math.max(0, Math.round((ms - Date.now()) / 60_000));
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
};
const hours = (min: number) => (min >= 60 ? `${Math.round(min / 6) / 10} h`.replace(".", ",") : `${min} min`);

/** A short line for the panel's header, and the mode pill beside it. */
export function awakeHeadline(a: Awake | null): { line: string; mode: string; on: boolean } {
  if (!a) return { line: "", mode: "", on: false };
  const mode = a.lidActive ? "víko" : a.prefs.manual ? "ručně" : a.prefs.auto ? "auto" : "vyp";
  if (!a.holding) return { line: a.why, mode, on: false };
  const who = a.working.slice(0, 2).join(", ");
  return { line: who ? `Držím vzhůru · ${who}` : a.why, mode, on: true };
}

function row(key: string, icon: string, title: string, control: string) {
  return `<div class="awr" data-row="${key}"><i>${icon}</i><div class="t"><b>${title}</b><small></small></div>${control}</div>`;
}
const sw = (key: string) => `<button class="sw" role="switch" data-sw="${key}" aria-checked="false"><span></span></button>`;

export function mountAwake(host: HTMLElement, onChange: (a: Awake) => void) {
  host.innerHTML = `
    <div class="pills">
      <span class="pill" data-p="bat">${ICON.bat}<b></b></span>
      <span class="pill" data-p="heat">${ICON.heat}<b></b></span>
      <span class="pill" data-p="cpu">${ICON.cpu}<b></b></span>
      <span class="pill" data-p="lid">${ICON.lid}<b></b></span>
    </div>
    <div class="awrows">
      ${row("auto", ICON.auto, "Automaticky", sw("auto"))}
      ${row("manual", ICON.eye, "Držet vzhůru", sw("manual"))}
      ${row("charging", ICON.bolt, "Jen v nabíječce", sw("chargingOnly"))}
      ${row("timer", ICON.timer, "Časovač", `<select data-sel="timer">${TIMERS.map(([m, t]) => `<option value="${m}">${t}</option>`).join("")}</select>`)}
      ${row("lid", ICON.lid, "Zavřené víko", `${sw("lid")}<button class="awbtn" data-act="lid-setup" hidden>Nastavit</button>`)}
      ${row("display", ICON.display, "Nezhasínat displej", sw("display"))}
      <div class="awsep"></div>
      <button class="awr act" data-act="sleep"><i>${ICON.moon}</i><div class="t"><b>Uspat teď</b><small>Pustí všechno a Mac usne</small></div></button>
      <details class="awmore" data-d="others"><summary class="awr"><i>${ICON.list}</i><div class="t"><b>Co drží Mac vzhůru</b><small></small></div><span class="chev">›</span></summary><div class="awlist"></div></details>
      <details class="awmore" data-d="opts"><summary class="awr"><i>${ICON.gear}</i><div class="t"><b>Pojistky</b><small></small></div><span class="chev">›</span></summary>
        <div class="awopts">
          <label>Se zavřeným víkem <select data-sel="lidUntilDone"><option value="1">jen dokud práce běží</option><option value="0">dokud to nevypnu</option></select></label>
          <label>Na baterii pustit pod <select data-sel="batteryStop">${[10, 15, 20, 30, 40].map((n) => `<option value="${n}">${n} %</option>`).join("")}</select></label>
          <label>Po práci uspat po <select data-sel="sleepAfterMin"><option value="0">nikdy</option>${[5, 10, 20, 30].map((n) => `<option value="${n}">${n} min klidu</option>`).join("")}</select></label>
        </div>
      </details>
    </div>
    <p class="awweek"></p>`;

  let cur: Awake | null = null;
  const q = <T extends HTMLElement>(sel: string) => host.querySelector(sel) as T;

  const send = async (patch: Record<string, unknown>) => {
    try {
      render(await invoke<Awake>("awake_set", { patch }));
    } catch (e) {
      sub("auto", String(e));
    }
  };
  const sub = (key: string, text: string) => {
    const el = host.querySelector<HTMLElement>(`[data-row="${key}"] small`);
    if (el) el.textContent = text;
  };

  function render(a: Awake) {
    cur = a;
    const p = a.prefs;
    for (const el of host.querySelectorAll<HTMLElement>("[data-sw]")) {
      const on = !!p[el.dataset.sw as keyof AwakePrefs];
      el.setAttribute("aria-checked", String(on));
    }
    // Pills: battery, heat, CPU, lid.
    const pill = (k: string, text: string, cls = "") => {
      const el = q<HTMLElement>(`[data-p="${k}"]`);
      el.className = `pill ${cls}`;
      (el.querySelector("b") as HTMLElement).textContent = text;
    };
    pill("bat", a.battery == null ? "–" : `${a.battery} %${a.charging ? " ⚡" : ""}`, a.battery != null && !a.onAc && a.battery <= p.batteryStop ? "warn" : "");
    pill("heat", HEAT[a.thermal] ?? "–", a.thermal >= 2 ? "warn" : "");
    pill("cpu", `${a.cpu} %`);
    pill("lid", a.lidActive ? "víko zap" : a.lidClosed ? "zavřené" : "víko vyp", a.lidActive ? "on" : "");

    sub("auto", p.auto ? (a.working.length ? a.working.slice(0, 4).join(", ") : "Nic nepracuje") : "Vypnuto");
    sub("manual", p.manual ? (p.untilMs ? `Ještě ${left(p.untilMs)}` : "Dokud to nevypneš") : "Mac usne jako obvykle");
    sub("charging", p.chargingOnly ? (a.onAc ? "Nabíječka je zapojená" : "Na baterii nedržím") : "I na baterii");
    sub("timer", p.untilMs ? `Vypne se v ${new Date(p.untilMs).toLocaleTimeString("cs-CZ", { hour: "numeric", minute: "2-digit" })}` : "Drží, dokud nevypneš");
    sub("display", p.display ? "Displej nezhasne" : "Displej zhasne jako obvykle");
    const lidSw = q<HTMLElement>('[data-sw="lid"]');
    const setup = q<HTMLElement>('[data-act="lid-setup"]');
    lidSw.hidden = !a.lidReady;
    setup.hidden = a.lidReady;
    sub(
      "lid",
      !a.lidReady
        ? "Jednou zadáš heslo k Macu"
        : a.lidActive
          ? "Klidně zavři víko. Dej Mac na tvrdou podložku"
          : p.lid
            ? p.lidUntilDone
              ? "Zapne se, až něco poběží"
              : "Čeká"
            : "Se zavřeným víkem Mac usne",
    );
    const timer = q<HTMLSelectElement>('[data-sel="timer"]');
    if (!p.untilMs) timer.value = "0";
    q<HTMLSelectElement>('[data-sel="lidUntilDone"]').value = p.lidUntilDone ? "1" : "0";
    q<HTMLSelectElement>('[data-sel="batteryStop"]').value = String(p.batteryStop);
    q<HTMLSelectElement>('[data-sel="sleepAfterMin"]').value = String(p.sleepAfterMin);
    q<HTMLElement>('[data-d="opts"] small').textContent = `Baterie pod ${p.batteryStop} % · horký Mac usne`;

    const others = q<HTMLElement>('[data-d="others"] small');
    others.textContent = a.others.length ? `${a.others.length} ${a.others.length === 1 ? "aplikace" : a.others.length < 5 ? "aplikace" : "aplikací"}${a.holding ? " a Wisp" : ""}` : a.holding ? "Jen Wisp" : "Nic";
    const list = [...(a.holding ? [{ app: "Wisp", what: a.why }] : []), ...a.others];
    q<HTMLElement>(".awlist").innerHTML = list.length
      ? list.map((h) => `<div><b>${esc(h.app)}</b><small>${esc(h.what)}</small></div>`).join("")
      : `<div><small>Nic Mac vzhůru nedrží, může usnout.</small></div>`;
    q<HTMLElement>(".awweek").textContent = a.error ?? (a.weekMinutes ? `Tento týden Mac pracoval ${hours(a.weekMinutes)} navíc` : "");
    onChange(a);
  }

  host.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const swEl = t.closest<HTMLElement>("[data-sw]");
    if (swEl && cur) {
      const key = swEl.dataset.sw as keyof AwakePrefs;
      const on = !cur.prefs[key];
      // Switching by-hand holding off also drops its timer.
      void send(key === "manual" && !on ? { manual: false, timerMin: 0 } : { [key]: on });
      return;
    }
    const act = t.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "sleep") void invoke("awake_sleep");
    if (act === "lid-setup") {
      sub("lid", "Zadej heslo v okně macOS…");
      invoke<Awake>("awake_lid_setup")
        .then((a) => {
          render(a);
          void send({ lid: true });
        })
        .catch((err) => sub("lid", String(err)));
    }
  });
  host.addEventListener("change", (e) => {
    const sel = (e.target as HTMLElement).closest<HTMLSelectElement>("[data-sel]");
    if (!sel) return;
    const v = Number(sel.value);
    if (sel.dataset.sel === "timer") void send(v ? { manual: true, timerMin: v } : { timerMin: 0 });
    if (sel.dataset.sel === "lidUntilDone") void send({ lidUntilDone: v === 1 });
    if (sel.dataset.sel === "batteryStop") void send({ batteryStop: v });
    if (sel.dataset.sel === "sleepAfterMin") void send({ sleepAfterMin: v });
  });

  void listen<Awake>("awake-state", (e) => render(e.payload));
  void invoke<Awake>("awake_status").then(render).catch(() => {});
  // The "still N min" texts move on their own.
  setInterval(() => cur && render(cur), 30_000);
}
