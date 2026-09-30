// Tasks for the agents (Paperclip issues): what is open, who has it, the
// conversation on it, and giving someone a new one.

import { pc } from "./live";

type Obj = Record<string, any>;

const STATUS: Record<string, string> = {
  backlog: "zásobník",
  todo: "k udělání",
  in_progress: "rozpracované",
  in_review: "ke kontrole",
  blocked: "čeká na tebe",
  done: "hotovo",
  cancelled: "zrušené",
};
const STATUS_CLASS: Record<string, string> = {
  backlog: "s-sleep",
  todo: "s-sleep",
  in_progress: "s-run",
  in_review: "s-you",
  blocked: "s-you",
  done: "s-ok",
  cancelled: "s-off",
};

const esc = (s: string) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const when = (iso: string) => new Date(iso).toLocaleString("cs-CZ", { day: "numeric", month: "numeric", hour: "numeric", minute: "2-digit" });

export type TasksContext = {
  companies: { company: Obj; agents: Obj[]; issues: Obj[] }[];
  toast: (text: string, ok?: boolean) => void;
  changed: () => void;
};

let openIssue: string | null = null;

export function renderTasks(el: HTMLElement, ctx: TasksContext) {
  const agentName = (id: string | null) => ctx.companies.flatMap((c) => c.agents).find((a) => a.id === id)?.name;
  const sorted = (issues: Obj[]) =>
    [...issues].sort((a, b) => Object.keys(STATUS).indexOf(a.status) - Object.keys(STATUS).indexOf(b.status) || b.updatedAt.localeCompare(a.updatedAt));

  el.innerHTML = `<div class="tasks">${ctx.companies
    .map(
      ({ company, issues }) => `
    <section>
      <h3>${esc(company.name)} <button class="add-job" data-new="${company.id}">+ Nový úkol</button></h3>
      ${
        issues.length
          ? sorted(issues)
              .map(
                (i) => `<button class="task${openIssue === i.id ? " on" : ""}" data-issue="${i.id}">
            <code>${esc(i.identifier)}</code><b>${esc(i.title)}</b>
            <span class="who">${esc(agentName(i.assigneeAgentId) ?? (i.assigneeUserId ? "ty" : "nikdo"))}</span>
            <span class="chip ${STATUS_CLASS[i.status] ?? ""}">${STATUS[i.status] ?? i.status}</span></button>
            ${openIssue === i.id ? `<div class="issue" data-body="${i.id}"><p class="muted">Načítám…</p></div>` : ""}`,
              )
              .join("")
          : `<p class="muted">Žádné otevřené úkoly.</p>`
      }
    </section>`,
    )
    .join("")}</div>`;

  el.querySelectorAll<HTMLButtonElement>("[data-issue]").forEach((b) =>
    b.addEventListener("click", () => {
      openIssue = openIssue === b.dataset.issue ? null : b.dataset.issue!;
      renderTasks(el, ctx);
    }),
  );
  el.querySelectorAll<HTMLButtonElement>("[data-new]").forEach((b) => b.addEventListener("click", () => newTask(b.dataset.new!)));

  const body = el.querySelector<HTMLElement>("[data-body]");
  if (body) void loadIssue(body, body.dataset.body!);

  async function loadIssue(box: HTMLElement, id: string) {
    const c = ctx.companies.find((x) => x.issues.some((i) => i.id === id))!;
    try {
      const [issue, comments] = await Promise.all([pc<Obj>("GET", `/issues/${id}`), pc<Obj[] | { items: Obj[] }>("GET", `/issues/${id}/comments`)]);
      const list = (Array.isArray(comments) ? comments : comments.items).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      box.innerHTML = `
        ${issue.description ? `<div class="desc">${esc(issue.description)}</div>` : ""}
        <div class="thread">${list
          .map(
            (m) => `<div class="msg${m.authorAgentId ? "" : " me"}"><small>${esc(m.authorAgentId ? agentName(m.authorAgentId) ?? "agent" : m.authorUserId ? "ty" : "Paperclip")} · ${when(m.createdAt)}</small>
            <div>${esc(m.body ?? "")}</div></div>`,
          )
          .join("")}</div>
        <textarea data-f="comment" rows="3" placeholder="Napiš agentovi…"></textarea>
        <div class="inline">
          <select data-f="status">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${issue.status === k ? "selected" : ""}>${v}</option>`).join("")}</select>
          <select data-f="assignee"><option value="">nikdo</option>${c.agents
            .map((a) => `<option value="${a.id}" ${issue.assigneeAgentId === a.id ? "selected" : ""}>${esc(a.name)}</option>`)
            .join("")}</select>
          <span class="spacer"></span>
          <button class="btn primary" data-act="send">Odeslat</button>
        </div>`;
      const thread = box.querySelector(".thread") as HTMLElement;
      thread.scrollTop = thread.scrollHeight;
      box.querySelector('[data-act="send"]')!.addEventListener("click", async (e) => {
        const b = e.currentTarget as HTMLButtonElement;
        const text = box.querySelector<HTMLTextAreaElement>('[data-f="comment"]')!.value.trim();
        const status = box.querySelector<HTMLSelectElement>('[data-f="status"]')!.value;
        const assignee = box.querySelector<HTMLSelectElement>('[data-f="assignee"]')!.value || null;
        b.disabled = true;
        try {
          if (text) await pc("POST", `/issues/${id}/comments`, { body: text });
          if (status !== issue.status || assignee !== (issue.assigneeAgentId ?? null)) {
            await pc("PATCH", `/issues/${id}`, { status, assigneeAgentId: assignee });
          }
          ctx.toast("Odesláno.", true);
          ctx.changed();
          await loadIssue(box, id);
        } catch (err) {
          ctx.toast(String(err));
        } finally {
          b.disabled = false;
        }
      });
    } catch (err) {
      box.innerHTML = `<p class="err">${esc(String(err))}</p>`;
    }
  }

  function newTask(companyId: string) {
    const c = ctx.companies.find((x) => x.company.id === companyId)!;
    const root = document.createElement("div");
    root.className = "studio-backdrop";
    root.innerHTML = `<div class="studio agentform"><header><h2>Nový úkol <em>v ${esc(c.company.name)}</em></h2>
      <button class="icon-btn" data-act="close">✕</button></header>
      <div class="form">
        <label class="row">Co<input type="text" data-f="title" maxlength="200" placeholder="Krátce, třeba Oprav padající test v domain"></label>
        <label class="row">Kdo<select data-f="agent"><option value="">zatím nikdo</option>${c.agents.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join("")}</select></label>
        <label class="row">Priorita<select data-f="priority"><option value="low">nízká</option><option value="medium" selected>střední</option><option value="high">vysoká</option><option value="critical">hoří</option></select></label>
        <div class="row top"><span>Podrobnosti</span><textarea data-f="desc" rows="10" placeholder="Co přesně má udělat, kde, a jak pozná, že je hotovo"></textarea></div>
        <p class="note"></p>
        <div class="btns"><span class="spacer"></span><button class="btn" data-act="close">Zrušit</button>
          <button class="btn primary" data-act="create">Zadat úkol</button></div>
      </div></div>`;
    document.body.appendChild(root);
    const q = <T extends HTMLElement>(s: string) => root.querySelector(s) as T;
    root.addEventListener("click", async (e) => {
      const t = e.target as HTMLElement;
      if (t === root || t.closest('[data-act="close"]')) return root.remove();
      if (!t.closest('[data-act="create"]')) return;
      const title = q<HTMLInputElement>('[data-f="title"]').value.trim();
      if (!title) return void (q(".note").textContent = "Úkol potřebuje název.");
      try {
        await pc("POST", `/companies/${companyId}/issues`, {
          title,
          description: q<HTMLTextAreaElement>('[data-f="desc"]').value,
          priority: q<HTMLSelectElement>('[data-f="priority"]').value,
          status: "todo",
          assigneeAgentId: q<HTMLSelectElement>('[data-f="agent"]').value || null,
        });
        root.remove();
        ctx.toast("Úkol zadaný. Agent se k němu dostane, jakmile se probudí.", true);
        ctx.changed();
      } catch (err) {
        q(".note").textContent = String(err);
      }
    });
    q<HTMLInputElement>('[data-f="title"]').focus();
  }
}
