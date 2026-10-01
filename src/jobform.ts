// Making a new launchd job from the app, or editing one the app made.

import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { Config } from "./config";
import type { Job } from "./model";

type Kind = "daily" | "interval" | "keepAlive" | "atLogin" | "manual";
const KINDS: [Kind, string][] = [
  ["daily", "V určitý čas"],
  ["interval", "Každých pár minut"],
  ["keepAlive", "Běží pořád"],
  ["atLogin", "Po přihlášení"],
  ["manual", "Jen ručně"],
];
// launchd weekdays: 0 = Sunday. Shown Monday first.
const DAYS: [number, string][] = [[1, "Po"], [2, "Út"], [3, "St"], [4, "Čt"], [5, "Pá"], [6, "So"], [0, "Ne"]];

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export function slugify(name: string) {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const shellQuote = (p: string) => `'${p.replace(/'/g, `'\\''`)}'`;

export type JobFormOptions = {
  cfg: Config;
  /** Editing this job; omitted for a new one. */
  job?: Job;
  save: () => Promise<void>;
  toast: (text: string, ok?: boolean) => void;
  /** After a new job exists: its item id, so the caller can select it. */
  created: (itemId: string) => void;
  changed: () => void;
};

export function openJobForm(o: JobFormOptions) {
  const { cfg, job } = o;
  const itemId = job ? `job:${job.label}` : "";
  const slugOf = (label: string) => label.replace(/^com\.erikkarasek\./, "");

  // Current schedule, in the form's terms.
  let kind: Kind = "daily";
  let times: string[] = ["08:00"];
  let weekdays = new Set<number>();
  let minutes = 60;
  if (job) {
    const s = job.schedule;
    if (s.kind === "calendar") {
      kind = "daily";
      times = [...new Set(s.times.map((t) => `${String(t.hour ?? 0).padStart(2, "0")}:${String(t.minute ?? 0).padStart(2, "0")}`))];
      weekdays = new Set(s.times.map((t) => t.weekday).filter((w): w is number => w != null));
    } else if (s.kind === "interval") {
      kind = "interval";
      minutes = Math.max(1, Math.round(s.seconds / 60));
    } else if (s.kind === "keepAlive") kind = "keepAlive";
    else if (s.kind === "onLoad") kind = "atLogin";
    else kind = "manual";
  }

  const root = document.createElement("div");
  root.className = "studio-backdrop";
  root.innerHTML = `
    <div class="studio jobform" role="dialog" aria-label="Úloha">
      <header><h2>${job ? `Upravit úlohu <em>${esc(cfg.names[itemId] ?? slugOf(job.label))}</em>` : "Nová úloha"}</h2>
        <button class="icon-btn" data-act="close" title="Zavřít (Esc)">✕</button></header>
      <div class="form">
        <label class="row">Jméno<input type="text" data-f="name" maxlength="40" placeholder="Třeba Záloha fotek"></label>
        <label class="row">Zkratka<span class="slug"><code>com.erikkarasek.</code><input type="text" data-f="slug" maxlength="40" ${job ? "disabled" : ""}></span></label>
        <label class="row">Co dělá<input type="text" data-f="note" maxlength="120" placeholder="Krátce, ukáže se na kartě"></label>
        <div class="row top"><span>Příkaz</span><div class="stack">
          <textarea data-f="command" rows="3" spellcheck="false" placeholder="Třeba: node ~/Developer/neco/index.js"></textarea>
          <div class="inline"><button class="btn" data-act="script">Vybrat skript…</button>
            <small>Běží v zsh s tvým PATH, jako v Terminálu.</small></div></div></div>
        <div class="row"><span>Složka</span><div class="inline"><input type="text" data-f="dir" placeholder="Volitelné">
          <button class="btn" data-act="dir">Vybrat…</button></div></div>
        <div class="row top"><span>Kdy</span><div class="stack">
          <div class="seg">${KINDS.map(([k, l]) => `<button data-kind="${k}">${l}</button>`).join("")}</div>
          <div class="when"></div></div></div>
        <label class="row"><span></span><span class="check"><input type="checkbox" data-f="runNow"> Spustit hned po uložení</span></label>
        <p class="note"></p>
        <div class="btns">
          ${job ? `<button class="btn" data-act="delete">Smazat úlohu</button>` : ""}
          <span class="spacer"></span>
          <button class="btn" data-act="close">Zrušit</button>
          <button class="btn primary" data-act="save">${job ? "Uložit" : "Založit úlohu"}</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(root);
  const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;

  q<HTMLInputElement>('[data-f="name"]').value = job ? cfg.names[itemId] ?? "" : "";
  q<HTMLInputElement>('[data-f="slug"]').value = job ? slugOf(job.label) : "";
  q<HTMLInputElement>('[data-f="note"]').value = job ? cfg.notes[itemId] ?? "" : "";
  q<HTMLTextAreaElement>('[data-f="command"]').value = job?.command ?? "";
  q<HTMLInputElement>('[data-f="dir"]').value = job?.workingDir ?? "";

  let slugTouched = !!job;
  q('[data-f="slug"]').addEventListener("input", () => (slugTouched = true));
  q('[data-f="name"]').addEventListener("input", (e) => {
    if (!slugTouched) q<HTMLInputElement>('[data-f="slug"]').value = slugify((e.target as HTMLInputElement).value);
  });

  function renderWhen() {
    root.querySelectorAll<HTMLElement>("[data-kind]").forEach((b) => b.classList.toggle("on", b.dataset.kind === kind));
    const when = q(".when");
    if (kind === "daily") {
      when.innerHTML = `
        <div class="times">${times.map((t, i) => `<span class="time"><input type="time" value="${t}" data-i="${i}">${times.length > 1 ? `<button data-rm="${i}" title="Odebrat">✕</button>` : ""}</span>`).join("")}
          <button class="btn" data-act="addTime">+ čas</button></div>
        <div class="days">${DAYS.map(([d, l]) => `<button data-day="${d}" class="${weekdays.has(d) ? "on" : ""}">${l}</button>`).join("")}
          <small>${weekdays.size ? "" : "každý den"}</small></div>`;
    } else if (kind === "interval") {
      when.innerHTML = `<span class="inline">každých <input type="number" min="1" max="1440" value="${minutes}" data-f="minutes"> minut</span>`;
    } else {
      when.innerHTML = `<small>${
        kind === "keepAlive" ? "Spustí se hned a když spadne, launchd ho pustí znovu." : kind === "atLogin" ? "Spustí se jednou po každém přihlášení." : "Spustíš ji tlačítkem ve Wispu."
      }</small>`;
    }
  }
  renderWhen();

  root.addEventListener("input", (e) => {
    const t = e.target as HTMLInputElement;
    if (t.type === "time") times[Number(t.dataset.i)] = t.value;
    if (t.dataset.f === "minutes") minutes = Number(t.value);
  });

  root.addEventListener("click", async (e) => {
    const el = e.target as HTMLElement;
    if (el === root) return close();
    const k = el.closest<HTMLElement>("[data-kind]");
    if (k) {
      kind = k.dataset.kind as Kind;
      return renderWhen();
    }
    const day = el.closest<HTMLElement>("[data-day]");
    if (day) {
      const d = Number(day.dataset.day);
      if (weekdays.has(d)) weekdays.delete(d);
      else weekdays.add(d);
      return renderWhen();
    }
    const rm = el.closest<HTMLElement>("[data-rm]");
    if (rm) {
      times.splice(Number(rm.dataset.rm), 1);
      return renderWhen();
    }
    const act = el.closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "close") return close();
    if (act === "addTime") {
      times.push("12:00");
      return renderWhen();
    }
    if (act === "script") {
      const file = await open({ multiple: false, directory: false, title: "Vyber skript" });
      if (typeof file === "string") q<HTMLTextAreaElement>('[data-f="command"]').value = shellQuote(file);
      return;
    }
    if (act === "dir") {
      const dir = await open({ multiple: false, directory: true, title: "Vyber složku" });
      if (typeof dir === "string") q<HTMLInputElement>('[data-f="dir"]').value = dir;
      return;
    }
    if (act === "delete" && job) {
      const b = el as HTMLButtonElement;
      if (b.dataset.armed !== "1") {
        b.dataset.armed = "1";
        b.textContent = "Opravdu smazat? Log zůstane.";
        setTimeout(() => {
          b.dataset.armed = "";
          b.textContent = "Smazat úlohu";
        }, 4000);
        return;
      }
      try {
        await invoke("job_delete", { label: job.label });
        delete cfg.names[itemId];
        delete cfg.notes[itemId];
        delete cfg.assignments[itemId];
        await o.save();
        o.toast("Úloha smazaná.", true);
        o.changed();
        close();
      } catch (err) {
        o.toast(String(err));
      }
      return;
    }
    if (act === "save") return save(el as HTMLButtonElement);
  });

  async function save(button: HTMLButtonElement) {
    const name = q<HTMLInputElement>('[data-f="name"]').value.trim();
    const slug = q<HTMLInputElement>('[data-f="slug"]').value.trim();
    const note = q<HTMLInputElement>('[data-f="note"]').value.trim();
    const schedule =
      kind === "daily"
        ? {
            kind,
            times: times.filter(Boolean).map((t) => ({ hour: Number(t.slice(0, 2)), minute: Number(t.slice(3, 5)) })),
            weekdays: [...weekdays],
          }
        : kind === "interval"
          ? { kind, minutes }
          : { kind };
    const spec = {
      slug,
      command: q<HTMLTextAreaElement>('[data-f="command"]').value,
      workingDir: q<HTMLInputElement>('[data-f="dir"]').value.trim() || null,
      schedule,
      runNow: q<HTMLInputElement>('[data-f="runNow"]').checked,
    };
    button.disabled = true;
    q(".note").textContent = "";
    try {
      const label = job ? job.label : await invoke<string>("job_create", { spec });
      if (job) await invoke("job_update", { label, spec });
      const id = `job:${label}`;
      if (name) cfg.names[id] = name;
      else delete cfg.names[id];
      if (note) cfg.notes[id] = note;
      else delete cfg.notes[id];
      await o.save();
      o.toast(job ? "Uloženo." : "Úloha založená.", true);
      close();
      if (job) o.changed();
      else o.created(id);
    } catch (err) {
      q(".note").textContent = String(err);
    } finally {
      button.disabled = false;
    }
  }

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
  q<HTMLInputElement>('[data-f="name"]').focus();
}
