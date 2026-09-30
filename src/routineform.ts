// Editing a routine (a scheduled task for an agent) or making a new one:
// what to do, who does it and when, without writing cron by hand.

import { pc } from "./live";

type Obj = Record<string, any>;
type Kind = "daily" | "weekly" | "hourly" | "manual" | "cron";
const DAYS: [number, string][] = [[1, "Po"], [2, "Út"], [3, "St"], [4, "Čt"], [5, "Pá"], [6, "So"], [0, "Ne"]];
const TZ = "Europe/Prague";

const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** Read a cron back into the form, when it is one of the simple shapes. */
function parse(cron: string | null): { kind: Kind; time: string; days: Set<number>; minute: number; raw: string } {
  const base = { kind: "manual" as Kind, time: "08:00", days: new Set<number>(), minute: 0, raw: cron ?? "" };
  if (!cron) return base;
  const [m, h, dom, mon, dow] = cron.trim().split(/\s+/);
  const pad = (n: string) => n.padStart(2, "0");
  if (dom === "*" && mon === "*" && /^\d+$/.test(m ?? "")) {
    if (h === "*" && dow === "*") return { ...base, kind: "hourly", minute: Number(m) };
    if (/^\d+$/.test(h ?? "")) {
      const time = `${pad(h)}:${pad(m)}`;
      if (dow === "*") return { ...base, kind: "daily", time };
      if (/^[0-7](,[0-7])*$/.test(dow ?? "")) return { ...base, kind: "weekly", time, days: new Set(dow.split(",").map((d) => Number(d) % 7)) };
    }
  }
  return { ...base, kind: "cron" };
}

export type RoutineFormOptions = {
  companyId: string;
  routine?: Obj;
  agents: Obj[];
  toast: (text: string, ok?: boolean) => void;
  changed: () => void;
};

export function openRoutineForm(o: RoutineFormOptions) {
  const r = o.routine;
  const trigger: Obj | undefined = (r?.triggers ?? []).find((t: Obj) => t.kind === "schedule");
  let when = parse(trigger?.cronExpression ?? (r ? null : "0 8 * * 1"));
  if (!r) when = { ...when, kind: "weekly", days: new Set([1]) };

  const root = document.createElement("div");
  root.className = "studio-backdrop";
  root.innerHTML = `<div class="studio agentform"><header><h2>${r ? `Upravit rutinu <em>${esc(r.title)}</em>` : "Nová rutina"}</h2>
    <button class="icon-btn" data-act="close" title="Zavřít (Esc)">✕</button></header>
    <div class="form">
      <label class="row">Název<input type="text" data-f="title" maxlength="120" value="${esc(r?.title ?? "")}" placeholder="Třeba Týdenní kontrola"></label>
      <label class="row">Kdo<select data-f="agent">${o.agents.map((a) => `<option value="${a.id}" ${r?.assigneeAgentId === a.id ? "selected" : ""}>${esc(a.name)}</option>`).join("")}</select></label>
      <div class="row"><span>Kdy</span><div class="stack">
        <div class="seg">
          <button data-kind="daily">Každý den</button><button data-kind="weekly">Určité dny</button>
          <button data-kind="hourly">Každou hodinu</button><button data-kind="manual">Jen ručně</button><button data-kind="cron">Vlastní cron</button>
        </div><div class="when"></div></div></div>
      <label class="row"><span></span><span class="check"><input type="checkbox" data-f="active" ${!r || r.status === "active" ? "checked" : ""}> Zapnutá</span></label>
      <div class="row top"><span>Co má udělat</span><textarea data-f="desc" rows="10" placeholder="Zadání, které agent dostane při každém spuštění"></textarea></div>
      <p class="note"></p>
      <div class="btns"><span class="spacer"></span>
        <button class="btn" data-act="close">Zrušit</button>
        <button class="btn primary" data-act="save">${r ? "Uložit" : "Založit rutinu"}</button></div>
    </div></div>`;
  document.body.appendChild(root);
  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
  q<HTMLTextAreaElement>('[data-f="desc"]').value = r?.description ?? "";

  function renderWhen() {
    root.querySelectorAll<HTMLElement>("[data-kind]").forEach((b) => b.classList.toggle("on", b.dataset.kind === when.kind));
    const el = q(".when");
    if (when.kind === "daily") el.innerHTML = `<span class="inline">v <input type="time" data-f="time" value="${when.time}"></span>`;
    else if (when.kind === "weekly")
      el.innerHTML = `<div class="days">${DAYS.map(([d, l]) => `<button data-day="${d}" class="${when.days.has(d) ? "on" : ""}">${l}</button>`).join("")}</div>
        <span class="inline">v <input type="time" data-f="time" value="${when.time}"></span>`;
    else if (when.kind === "hourly") el.innerHTML = `<span class="inline">v minutu <input type="number" min="0" max="59" data-f="minute" value="${when.minute}"></span>`;
    else if (when.kind === "cron") el.innerHTML = `<span class="inline"><input type="text" data-f="raw" value="${esc(when.raw)}" placeholder="5 8 * * 1"> <small>čas Praha</small></span>`;
    else el.innerHTML = `<small>Spustíš ji tlačítkem „Spustit teď“.</small>`;
  }
  renderWhen();

  root.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.dataset.f === "time") when.time = t.value;
    if (t.dataset.f === "minute") when.minute = Number(t.value);
    if (t.dataset.f === "raw") when.raw = t.value;
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  };
  document.addEventListener("keydown", onKey, true);
  function close() {
    document.removeEventListener("keydown", onKey, true);
    root.remove();
  }

  root.addEventListener("click", async (e) => {
    const el = e.target as HTMLElement;
    if (el === root || el.closest('[data-act="close"]')) return close();
    const k = el.closest<HTMLElement>("[data-kind]");
    if (k) {
      when.kind = k.dataset.kind as Kind;
      return renderWhen();
    }
    const d = el.closest<HTMLElement>("[data-day]");
    if (d) {
      const n = Number(d.dataset.day);
      if (when.days.has(n)) when.days.delete(n);
      else when.days.add(n);
      return renderWhen();
    }
    if (el.closest('[data-act="save"]')) await save(el as HTMLButtonElement);
  });

  function cron(): string | null {
    const [h, m] = when.time.split(":").map(Number);
    if (when.kind === "daily") return `${m} ${h} * * *`;
    if (when.kind === "weekly") return when.days.size ? `${m} ${h} * * ${[...when.days].sort().join(",")}` : null;
    if (when.kind === "hourly") return `${Math.min(59, Math.max(0, when.minute))} * * * *`;
    if (when.kind === "cron") return when.raw.trim() || null;
    return null;
  }

  async function save(button: HTMLButtonElement) {
    const title = q<HTMLInputElement>('[data-f="title"]').value.trim();
    if (!title) return void (q(".note").textContent = "Rutina potřebuje název.");
    const expr = cron();
    if (when.kind === "weekly" && !expr) return void (q(".note").textContent = "Vyber aspoň jeden den.");
    const body = {
      title,
      description: q<HTMLTextAreaElement>('[data-f="desc"]').value,
      assigneeAgentId: q<HTMLSelectElement>('[data-f="agent"]').value || null,
      status: q<HTMLInputElement>('[data-f="active"]').checked ? "active" : "paused",
    };
    button.disabled = true;
    try {
      const saved = r ? await pc<Obj>("PATCH", `/routines/${r.id}`, body) : await pc<Obj>("POST", `/companies/${o.companyId}/routines`, body);
      const id = r?.id ?? saved.id;
      if (trigger) {
        await pc("PATCH", `/routine-triggers/${trigger.id}`, expr ? { cronExpression: expr, timezone: TZ, enabled: true } : { enabled: false });
      } else if (expr) {
        await pc("POST", `/routines/${id}/triggers`, { kind: "schedule", cronExpression: expr, timezone: TZ });
      }
      o.toast(r ? "Rutina uložená." : "Rutina založená.", true);
      close();
      o.changed();
    } catch (err) {
      q(".note").textContent = String(err);
    } finally {
      button.disabled = false;
    }
  }
}
