// Editing a Paperclip agent, or hiring a new one, without leaving Dispečink:
// name, role, boss, model, budget, waking on its own, skills and instructions.

import { invoke } from "@tauri-apps/api/core";

type Obj = Record<string, any>;

const ROLES: [string, string][] = [
  ["general", "Obecný"],
  ["engineer", "Programátor"],
  ["qa", "Tester"],
  ["devops", "DevOps"],
  ["researcher", "Rešeršér"],
  ["designer", "Designér"],
  ["pm", "Produkťák"],
  ["security", "Bezpečnost"],
  ["ceo", "Šéf (CEO)"],
  ["cto", "CTO"],
  ["cmo", "Marketing (CMO)"],
  ["cfo", "Finance (CFO)"],
];

const PATH_ENV = "/Users/erickos007/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const request = <T = any,>(method: string, path: string, body?: unknown) =>
  invoke<T>("paperclip_request", { method, path, body: body ?? null });

function starterInstructions(name: string, title: string) {
  return `You are ${name || "a new agent"}${title ? `, ${title}` : ""}.

## When you wake

Check out the issue you were assigned and read it with its parent. Do the work
it asks for, then comment what you did and set the issue's status.

## GitHub access

Use only the \`GH_TOKEN\` in your environment. Never use another login. If it is
missing or GitHub answers 401 or 403, comment the error, set the issue to
\`blocked\` for Erik and stop.

## Never

- merge, push to \`main\`, tag, or touch releases
- read, print, change or ask for a secret

Execution contract:

- Start the work in the same heartbeat you check the issue out.
- Leave a comment with where you are and the next step before every exit.
- If you are blocked, say what blocks you and who can unblock it.
`;
}

export type AgentFormOptions = {
  companyId: string;
  companyName: string;
  /** The company's issue prefix, which is also its path in the Paperclip UI. */
  companyPrefix: string;
  /** The agent being edited; omitted when hiring a new one. */
  agentId?: string;
  /** Everyone in the company, for "reports to". */
  agents: Obj[];
  paperclipUrl: string;
  toast: (text: string, ok?: boolean) => void;
  changed: () => void;
  created: (itemId: string) => void;
};

export async function openAgentForm(o: AgentFormOptions) {
  const root = document.createElement("div");
  root.className = "studio-backdrop";
  root.innerHTML = `<div class="studio agentform"><header><h2>${o.agentId ? "Upravit agenta" : `Nový agent <em>v ${esc(o.companyName)}</em>`}</h2>
    <button class="icon-btn" data-act="close" title="Zavřít (Esc)">✕</button></header>
    <div class="form"><p class="muted">Načítám…</p></div></div>`;
  document.body.appendChild(root);
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
  root.addEventListener("click", (e) => {
    if (e.target === root || (e.target as HTMLElement).closest('[data-act="close"]')) close();
  });

  let agent: Obj | null = null;
  let instructions = "";
  let models: { id: string; label: string }[] = [];
  let skills: Obj[] = [];
  try {
    [models, skills] = await Promise.all([
      request(`GET`, `/companies/${o.companyId}/adapters/claude_local/models`).catch(() => []),
      request(`GET`, `/companies/${o.companyId}/skills`).catch(() => []),
    ]);
    if (o.agentId) {
      agent = await request("GET", `/agents/${o.agentId}`);
      const file = await request("GET", `/agents/${o.agentId}/instructions-bundle/file?path=AGENTS.md`).catch(() => null);
      instructions = file?.content ?? "";
    }
  } catch (err) {
    root.querySelector(".form")!.innerHTML = `<p class="err">${esc(String(err))}</p>`;
    return;
  }

  const cfg = agent?.adapterConfig ?? {};
  const model = cfg.model ?? "claude-sonnet-5";
  if (!models.some((m) => m.id === model)) models.unshift({ id: model, label: model });
  const heartbeat = agent?.runtimeConfig?.heartbeat ?? {};
  const chosen = new Set<string>(cfg.paperclipSkillSync?.desiredSkills ?? ["paperclip"]);
  // Stored keys are short ("paperclip", "company/<id>/<slug>"); the list gives long ones.
  const shortKey = (s: Obj) => (s.key.startsWith("company/") ? s.key : s.slug);
  const others = o.agents.filter((a) => a.id !== o.agentId);
  const hasToken = cfg.env?.GH_TOKEN?.type === "secret_ref";

  const form = root.querySelector(".form") as HTMLElement;
  form.innerHTML = `
    <label class="row">Jméno<input type="text" data-f="name" maxlength="40" value="${esc(agent?.name ?? "")}" placeholder="Třeba Reviewer"></label>
    <label class="row">Role<select data-f="role">${ROLES.map(([v, l]) => `<option value="${v}" ${(agent?.role ?? "general") === v ? "selected" : ""}>${l}</option>`).join("")}</select></label>
    <label class="row">Co dělá<input type="text" data-f="title" maxlength="80" value="${esc(agent?.title ?? "")}" placeholder="Krátký popis, třeba Code reviewer"></label>
    <label class="row">Nadřízený<select data-f="reportsTo"><option value="">nikdo</option>${others
      .map((a) => `<option value="${a.id}" ${agent?.reportsTo === a.id ? "selected" : ""}>${esc(a.name)}</option>`)
      .join("")}</select></label>
    <label class="row">Model<select data-f="model">${models.map((m) => `<option value="${esc(m.id)}" ${m.id === model ? "selected" : ""}>${esc(m.label)}</option>`).join("")}</select></label>
    <label class="row">Rozpočet<span class="inline"><input type="number" data-f="budget" min="0" step="1" value="${Math.round((agent?.budgetMonthlyCents ?? 500) / 100)}"> $ měsíčně, pak se sám pozastaví</span></label>
    <div class="row"><span>Probouzení</span><span class="inline"><label class="check"><input type="checkbox" data-f="hb" ${heartbeat.enabled ? "checked" : ""}> samo každých</label>
      <input type="number" data-f="hbMin" min="5" step="5" value="${Math.max(5, Math.round((heartbeat.intervalSec ?? 3600) / 60))}"> min <small>jinak jen když dostane úkol</small></span></div>
    <div class="row"><span>GitHub token</span><span class="inline">
      <input type="password" data-f="ghToken" autocomplete="off" spellcheck="false" placeholder="${hasToken ? "Má token. Nový ho nahradí." : "Nemá token"}" style="flex:1">
      <small>uloží se šifrovaně, zpátky ho už nikdo neuvidí</small></span></div>
    <div class="row top"><span>Skilly</span><div class="skills">${skills
      .map((s) => `<label class="check" title="${esc(s.description ?? "")}"><input type="checkbox" data-skill="${esc(shortKey(s))}" ${chosen.has(shortKey(s)) ? "checked" : ""}> ${esc(s.slug)}</label>`)
      .join("")}</div></div>
    <div class="row top"><span>Instrukce</span><textarea data-f="instructions" rows="14" spellcheck="false"></textarea></div>
    <p class="note"></p>
    <div class="btns">
      ${agent ? `<button class="btn" data-act="delete">Smazat agenta</button>` : ""}
      <span class="spacer"></span>
      <button class="btn" data-act="close">Zrušit</button>
      <button class="btn primary" data-act="save">${agent ? "Uložit" : "Založit agenta"}</button>
    </div>`;
  const q = <T extends HTMLElement>(s: string) => form.querySelector(s) as T;
  q<HTMLTextAreaElement>('[data-f="instructions"]').value = agent ? instructions : starterInstructions("", "");
  if (!agent) {
    // Keep the starter text in step with the name until the user edits it.
    let touched = false;
    q('[data-f="instructions"]').addEventListener("input", () => (touched = true));
    const sync = () => {
      if (!touched) q<HTMLTextAreaElement>('[data-f="instructions"]').value = starterInstructions(q<HTMLInputElement>('[data-f="name"]').value.trim(), q<HTMLInputElement>('[data-f="title"]').value.trim());
    };
    q('[data-f="name"]').addEventListener("input", sync);
    q('[data-f="title"]').addEventListener("input", sync);
  }

  form.addEventListener("click", async (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
    if (act === "open") {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(`${o.paperclipUrl}/${o.companyPrefix}/agents${agent ? `/${agent.urlKey ?? agent.id}` : ""}`);
    } else if (act === "delete" && agent) {
      const b = e.target as HTMLButtonElement;
      if (b.dataset.armed !== "1") {
        b.dataset.armed = "1";
        b.textContent = "Opravdu smazat? Nejde vrátit.";
        setTimeout(() => {
          b.dataset.armed = "";
          b.textContent = "Smazat agenta";
        }, 4000);
        return;
      }
      try {
        await request("DELETE", `/agents/${agent.id}`);
        o.toast(`${agent.name} smazaný.`, true);
        o.changed();
        close();
      } catch (err) {
        q(".note").textContent = String(err);
      }
    } else if (act === "save") {
      await save(e.target as HTMLButtonElement);
    }
  });

  /** A new GitHub token: replace the value of the agent's secret, or give it one. */
  async function setToken(agentId: string, name: string) {
    const token = q<HTMLInputElement>('[data-f="ghToken"]').value.trim();
    if (!token) return;
    const fresh = await request<Obj>("GET", `/agents/${agentId}`);
    const env: Obj = {};
    for (const [k, v] of Object.entries<Obj>(fresh.adapterConfig?.env ?? {})) {
      env[k] = v && typeof v === "object" && v.type === "secret_ref" ? { type: "secret_ref", secretId: v.secretId, version: v.version ?? "latest" } : v;
    }
    if (env.GH_TOKEN?.type === "secret_ref") {
      await request("POST", `/secrets/${env.GH_TOKEN.secretId}/rotate`, { value: token });
      return;
    }
    const slug = name.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_");
    const secret = await request<Obj>("POST", `/companies/${o.companyId}/secrets`, { name: `gh_token_${slug}_${Date.now().toString(36)}`, value: token });
    env.GH_TOKEN = { type: "secret_ref", secretId: secret.id, version: "latest" };
    await request("PATCH", `/agents/${agentId}`, { adapterConfig: { env } });
  }

  async function save(button: HTMLButtonElement) {
    const name = q<HTMLInputElement>('[data-f="name"]').value.trim();
    if (!name) {
      q(".note").textContent = "Agent potřebuje jméno.";
      return;
    }
    const desiredSkills = [...form.querySelectorAll<HTMLInputElement>("[data-skill]")].filter((c) => c.checked).map((c) => c.dataset.skill!);
    const hb = {
      ...(agent?.runtimeConfig?.heartbeat ?? {}),
      enabled: q<HTMLInputElement>('[data-f="hb"]').checked,
      intervalSec: Math.max(5, Number(q<HTMLInputElement>('[data-f="hbMin"]').value) || 60) * 60,
    };
    const common = {
      name,
      role: q<HTMLSelectElement>('[data-f="role"]').value,
      title: q<HTMLInputElement>('[data-f="title"]').value.trim() || null,
      reportsTo: q<HTMLSelectElement>('[data-f="reportsTo"]').value || null,
      budgetMonthlyCents: Math.max(0, Math.round(Number(q<HTMLInputElement>('[data-f="budget"]').value) || 0)) * 100,
      runtimeConfig: { ...(agent?.runtimeConfig ?? {}), heartbeat: hb },
    };
    const model = q<HTMLSelectElement>('[data-f="model"]').value;
    const text = q<HTMLTextAreaElement>('[data-f="instructions"]').value;
    button.disabled = true;
    q(".note").textContent = "";
    try {
      if (agent) {
        // adapterConfig is merged key by key, so env and the rest stay as they are.
        await request("PATCH", `/agents/${agent.id}`, { ...common, adapterConfig: { model, paperclipSkillSync: { desiredSkills } } });
        if (text !== instructions) await request("PUT", `/agents/${agent.id}/instructions-bundle/file`, { path: "AGENTS.md", content: text });
        await setToken(agent.id, name);
        o.toast(`${name} uložený.`, true);
        close();
        o.changed();
      } else {
        const made = await request<Obj>("POST", `/companies/${o.companyId}/agents`, {
          ...common,
          adapterType: "claude_local",
          adapterConfig: {
            model,
            paperclipSkillSync: { desiredSkills },
            // So gh and claude from ~/.local/bin are found, like the other agents.
            env: { PATH: { type: "plain", value: PATH_ENV } },
          },
          instructionsBundle: { entryFile: "AGENTS.md", files: { "AGENTS.md": text } },
        });
        await setToken(made.id, name);
        o.toast(`${name} založený.`, true);
        close();
        o.created(`agent:${made.id}`);
      }
    } catch (err) {
      q(".note").textContent = String(err);
    } finally {
      button.disabled = false;
    }
  }
}
